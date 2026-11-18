package com.tripcraft.backend.chat;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.config.EnvFile;
import com.tripcraft.backend.external.GroqService;
import com.tripcraft.backend.external.OllamaService;
import com.tripcraft.backend.infra.Json;

/**
 * The streaming half of the structured chat route — the port of the
 * {@code ReadableStream} body of the TS {@code POST /api/chat}.
 *
 * <p>Wire format: newline-delimited JSON (NDJSON), one event per line:
 *
 * <pre>
 *   {"type":"delta","text":"…"}   intro characters
 *   {"type":"reset"}              discard the intro streamed so far (retry)
 *   {"type":"done","reply":{…}}   validated, normalised reply
 *   {"type":"error","message":"…"} friendly failure (no model output)
 * </pre>
 *
 * <p>The route streams the {@code intro} field while the rest of the object is
 * still being generated, validates the finished object with the zod-equivalent
 * {@link AiSchema}, retries ONCE with the validation errors when the output is
 * unusable, and emits the validated reply — raw JSON is never shown to the
 * user.
 */
@Service
public class ChatStream {

    private static final Logger log = LoggerFactory.getLogger(ChatStream.class);

    /** The key the intro-forwarder seeks so the first sentence streams early. */
    private static final String INTRO_KEY = "\"intro\"";

    /**
     * Ceiling on the LOCAL path when it is the only backend (no
     * GROQ_API_KEY): stream for at most 90s, then its correction pass for at
     * most 45s — TS {@code KEYLESS_OLLAMA_BUDGET_MS}. There is nothing faster
     * to fall back to, so the budget is generous — but it is still a budget.
     */
    static final int KEYLESS_OLLAMA_BUDGET_MS = 90_000;

    /** TS default of {@code ollamaChat} in the correction retry. */
    private static final double OLLAMA_RETRY_TEMPERATURE = 0.2;
    private static final int OLLAMA_RETRY_NUM_PREDICT = 3072;

    private final GroqService groq;
    private final OllamaService ollama;

    public ChatStream(GroqService groq, OllamaService ollama) {
        this.groq = groq;
        this.ollama = ollama;
    }

    // --------------------------------------------------------------- sink

    /** Where NDJSON events go — the client, or a collector in JSON mode. */
    public interface Sink {

        /** Incremental intro text. */
        void delta(String text);

        /** Discard the intro streamed so far; a fresh reply follows. */
        void reset();

        /** The validated reply. */
        void done(AiReply reply);

        /** Friendly failure (no usable model output). */
        void error(String message);
    }

    /**
     * Streams the events as NDJSON lines to the servlet output, flushing after
     * every line so the client renders the intro while the rest of the object
     * is still generating.
     */
    public static final class NdjsonSink implements Sink {

        private final OutputStream out;

        public NdjsonSink(OutputStream out) {
            this.out = out;
        }

        @Override
        public void delta(String text) {
            ObjectNode event = Json.obj();
            event.put("type", "delta");
            event.put("text", text);
            emit(event);
        }

        @Override
        public void reset() {
            ObjectNode event = Json.obj();
            event.put("type", "reset");
            emit(event);
        }

        @Override
        public void done(AiReply reply) {
            ObjectNode event = Json.obj();
            event.put("type", "done");
            // The plain ObjectMapper keeps EVERY reply key present, exactly
            // like JSON.stringify(zod-parsed reply) in the TS — the client
            // maps reply.places into cards, so a missing key means no cards.
            event.set("reply", Json.M.valueToTree(reply));
            emit(event);
        }

        @Override
        public void error(String message) {
            ObjectNode event = Json.obj();
            event.put("type", "error");
            // The TS sends `message` and the chat page reads `event.message`;
            // `error` carries the same wording for generic consumers of this
            // wire contract.
            event.put("message", message);
            event.put("error", message);
            emit(event);
        }

        /** One newline-terminated JSON line; a gone client is swallowed. */
        private void emit(ObjectNode event) {
            String line = Json.write(event) + "\n";
            try {
                out.write(line.getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (IOException clientWentAway) {
                // Client went away mid-stream — same as the TS send() try/catch.
            }
        }
    }

    // --------------------------------------------------------------- drive

    /**
     * Run one prepared turn: keyless mode goes to Ollama (it is the only
     * backend there), otherwise Groq streams the intro and gets exactly one
     * correction retry before the turn fails with cause-matched wording.
     */
    public void run(ChatSupport.Turn turn, Sink sink) {
        try {
            if (keyless()) {
                // Keyless mode: Ollama is the ONLY backend, so it gets a real
                // budget — there is nothing faster to fall back to.
                respondWithOllama(turn, sink);
                return;
            }

            // --- Attempt 1: stream the intro while the object is generated ---
            // Factual turns run cold (0.3) so facts don't drift; planning turns
            // get a little more variety (0.5). See AiIntent.temperature().
            IntroForwarder intro = new IntroForwarder(sink::delta);
            StringBuilder raw = new StringBuilder();
            groq.chatStream(turn.messages(), turn.intent().temperature(), turn.intent().maxTokens(),
                    chunk -> {
                        raw.append(chunk);
                        intro.push(chunk);
                    });

            AiSchema.ParseResult first = AiSchema.parseAiReply(raw.toString());
            if (first.ok()) {
                sink.done(turn.finisher().apply(first.reply()));
                return;
            }

            // --- Retry once: the intro we just streamed may be unusable ---
            log.warn("[chat] invalid structured output, retrying: {}",
                    AiSchema.formatRejection(first.errors()));
            sink.reset();

            String rejected = raw.toString();
            List<GroqService.Message> retryMessages = new ArrayList<>(turn.messages());
            retryMessages.add(GroqService.Message.assistant(Js.slice(rejected, 0, 3000)));
            retryMessages.add(GroqService.Message.user(
                    "That reply was rejected: " + AiSchema.formatRejection(first.errors()) + ". "
                            + "Return ONLY the corrected JSON object, with the keys intro, destination, dates, "
                            + "places, itinerary, followUpQuestion, suggestions in that order. "
                            + "Numbers must be numbers, no prose outside the object. "
                            + "Keep the limits from the \"## This turn\" block: intro ≤ "
                            + turn.intent().maxIntro() + " characters, "
                            + "at most " + turn.intent().maxPlaces() + " place(s), itinerary "
                            + (turn.intent().allowItinerary() ? "allowed" : "must be []") + "."));

            String retried = null;
            boolean retryRateLimited = false;
            try {
                retried = groq.chat(retryMessages,
                        Math.max(0.2, turn.intent().temperature() - 0.1),
                        Math.max(turn.intent().maxTokens(), 2400));
            } catch (RuntimeException err) {
                String reason = messageOf(err);
                // The free tier caps 8,000 tokens/min — a retry that follows
                // straight after a full generation is almost always over quota.
                retryRateLimited = ChatSupport.rateLimited(reason);
                log.error("[chat] retry failed: {}", reason);
            }

            AiSchema.ParseResult second =
                    retried != null && !retried.isEmpty() ? AiSchema.parseAiReply(retried) : null;
            if (second != null && second.ok()) {
                sink.done(turn.finisher().apply(second.reply()));
                return;
            }

            // The dev hint carries the ORIGINAL rejection so the first
            // attempt's failure is diagnosable from a single request.
            sink.error(ChatSupport.failMessage(
                    retryRateLimited
                            ? "429 on correction retry; first attempt: "
                                    + AiSchema.formatRejection(first.errors())
                            : second != null
                                    ? "correction rejected: " + AiSchema.formatRejection(second.errors())
                                    : (retried != null && !retried.isEmpty())
                                            ? "correction reply was not JSON"
                                            : "correction unavailable"));
        } catch (RuntimeException err) {
            String reason = messageOf(err);
            log.error("[chat] stream error: {}", reason);
            // Free-tier Groq throttles (429 / daily token quota) and can also
            // fail outright. Discard any intro already streamed and tell the
            // user what happened right away. The local model is deliberately
            // NOT used as a rescue here: at ~8 tokens/s it needs a minute-plus
            // to emit a full structured reply — exactly the multi-minute stall
            // this overhaul exists to remove.
            sink.reset();
            sink.error(ChatSupport.failMessage(reason));
        }
    }

    // ------------------------------------------------------------- ollama

    /** Local Ollama path (keyless mode). Same contract — stream the intro,
     *  validate, apply policy, emit. */
    private void respondWithOllama(ChatSupport.Turn turn, Sink sink) {
        try {
            // Stream like the Groq path: the intro reaches the user while the
            // rest of the object is still generating (a local 4B model can
            // need a while).
            IntroForwarder intro = new IntroForwarder(sink::delta);
            StringBuilder raw = new StringBuilder();
            // A cold model load stalls BEFORE the first byte, so the ceiling
            // rides on the fetch signal itself — the timeout parameter bounds
            // headers and generation alike.
            int budgetMs = KEYLESS_OLLAMA_BUDGET_MS;
            ollama.chatStream(turn.messages(), turn.intent().temperature(), turn.intent().maxTokens(),
                    budgetMs, chunk -> {
                        raw.append(chunk);
                        intro.push(chunk);
                    });

            AiSchema.ParseResult first = AiSchema.parseAiReply(raw.toString());
            if (first.ok()) {
                sink.done(turn.finisher().apply(first.reply()));
                return;
            }
            log.warn("[chat] Ollama output invalid, retrying: {}",
                    AiSchema.formatRejection(first.errors()));
            sink.reset();

            String rejected = raw.toString();
            List<GroqService.Message> retryMessages = new ArrayList<>(turn.messages());
            retryMessages.add(GroqService.Message.assistant(Js.slice(rejected, 0, 3000)));
            retryMessages.add(GroqService.Message.user(
                    "That reply was rejected: " + AiSchema.formatRejection(first.errors()) + ". "
                            + "Return ONLY the corrected JSON object, with the keys intro, destination, dates, "
                            + "places, itinerary, followUpQuestion, suggestions in that order."));

            String retried = "";
            try {
                retried = ollama.chat(retryMessages, OLLAMA_RETRY_TEMPERATURE, OLLAMA_RETRY_NUM_PREDICT,
                        budgetMs / 2);
            } catch (RuntimeException err) {
                // TS `.catch(() => "")` — a failed correction is "no correction".
            }

            AiSchema.ParseResult second =
                    retried == null || retried.isEmpty() ? null : AiSchema.parseAiReply(retried);
            if (second != null && second.ok()) {
                sink.done(turn.finisher().apply(second.reply()));
                return;
            }
            sink.error("No AI backend is available right now. "
                    + "Set GROQ_API_KEY (free tier works) or run Ollama locally.");
        } catch (RuntimeException err) {
            log.error("Ollama fallback error: {}", messageOf(err));
            sink.error("No AI backend available. Please try again later.");
        }
    }

    /** TS {@code !process.env.GROQ_API_KEY?.trim()} — blank key means keyless mode. */
    private static boolean keyless() {
        String key = EnvFile.get("GROQ_API_KEY");
        return key == null || key.isBlank();
    }

    private static String messageOf(Throwable err) {
        String message = err == null ? null : err.getMessage();
        return message == null || message.isEmpty() ? String.valueOf(err) : message;
    }

    // --------------------------------------------------- intro forwarder

    /**
     * Incrementally decodes the {@code intro} JSON string while the rest of
     * the object is still being generated, so the first sentence reaches the
     * user immediately — the port of the TS {@code IntroForwarder} class.
     */
    static final class IntroForwarder {

        private enum State {
            SEEK,
            DECODE,
            DONE
        }

        private String buffer = "";
        private int consumed;
        private State state = State.SEEK;

        private final java.util.function.Consumer<String> emit;

        IntroForwarder(java.util.function.Consumer<String> emit) {
            this.emit = emit;
        }

        /** Narrowing-safe: methods below may flip {@code state} to DONE. */
        private boolean isDone() {
            return state == State.DONE;
        }

        void push(String chunk) {
            if (isDone()) {
                return;
            }
            buffer += chunk;
            if (state == State.SEEK) {
                seek();
            }
            if (state == State.DECODE) {
                decode();
            }
            // Bound the buffer: nothing useful after the intro has been decoded.
            if (isDone() || consumed > 4000) {
                state = State.DONE;
                buffer = "";
            }
        }

        /** Find {@code "intro"} … {@code :"}} and slide into DECODE mode. */
        private void seek() {
            for (; ; ) {
                int at = buffer.indexOf(INTRO_KEY, consumed);
                if (at == -1) {
                    // Keep only a tail in case the key straddles two chunks.
                    if (buffer.length() > 256) {
                        consumed = 0;
                        buffer = buffer.substring(buffer.length() - 128);
                    }
                    return;
                }
                int i = at + INTRO_KEY.length();
                while (i < buffer.length() && isJsonWhitespace(buffer.charAt(i))) {
                    i++;
                }
                if (i >= buffer.length()) {
                    return; // need more bytes
                }
                if (buffer.charAt(i) != ':') {
                    consumed = at + INTRO_KEY.length();
                    continue; // e.g. "introText" — keep looking
                }
                i++;
                while (i < buffer.length() && isJsonWhitespace(buffer.charAt(i))) {
                    i++;
                }
                if (i >= buffer.length()) {
                    return;
                }
                if (buffer.charAt(i) != '"') {
                    state = State.DONE; // intro isn't a string — nothing to stream
                    return;
                }
                buffer = buffer.substring(i + 1);
                consumed = 0;
                state = State.DECODE;
                return;
            }
        }

        /** Decode as much of the intro string as has fully arrived. */
        private void decode() {
            StringBuilder out = new StringBuilder();
            int i = consumed;
            while (i < buffer.length()) {
                char ch = buffer.charAt(i);
                if (ch == '"') {
                    break; // closing quote — end of intro
                }
                if (ch == '\\') {
                    if (i + 1 >= buffer.length()) {
                        break; // escape split across chunks
                    }
                    char next = buffer.charAt(i + 1);
                    if (next == 'u') {
                        if (i + 6 > buffer.length()) {
                            break;
                        }
                        double code = parseHex4(buffer.substring(i + 2, i + 6));
                        if (!Double.isNaN(code)) {
                            out.append((char) (int) code);
                        }
                        i += 6;
                    } else {
                        out.append(unescape(next));
                        i += 2;
                    }
                    continue;
                }
                out.append(ch);
                i++;
            }
            consumed = i;
            if (i < buffer.length() && buffer.charAt(i) == '"') {
                state = State.DONE;
                buffer = "";
            }
            if (out.length() > 0) {
                emit.accept(out.toString());
            }
        }

        /** The JSON short escapes — {@code \b} and {@code \f} included. */
        private static char unescape(char next) {
            switch (next) {
                case 'n':
                    return '\n';
                case 't':
                    return '\t';
                case 'r':
                    return '\r';
                case 'b':
                    return '\b';
                case 'f':
                    return '\f';
                default:
                    return next; // " \\ / and anything unknown → the char itself
            }
        }

        /** JS {@code parseInt(hex, 16)} → NaN as {@link Double#NaN}. */
        private static double parseHex4(String hex) {
            try {
                return (double) Integer.parseInt(hex, 16);
            } catch (NumberFormatException notHex) {
                return Double.NaN;
            }
        }

        /** JS {@code /\s/.test(ch)} for the whitespace runs around the colon. */
        private static boolean isJsonWhitespace(char ch) {
            return Character.isWhitespace(ch) || Character.isSpaceChar(ch);
        }
    }
}
