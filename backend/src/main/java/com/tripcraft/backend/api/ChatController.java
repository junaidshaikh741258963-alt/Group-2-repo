package com.tripcraft.backend.api;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.tripcraft.backend.chat.AiSchema.AiReply;
import com.tripcraft.backend.chat.ChatStream;
import com.tripcraft.backend.chat.ChatSupport;
import com.tripcraft.backend.infra.Json;

/**
 * Structured chat endpoint — the port of {@code src/app/api/chat/route.ts}.
 *
 * <p>The model answers with ONE JSON object (see {@code AiSchema}). The route:
 *
 * <ol>
 *   <li>streams the {@code intro} field to the client as it arrives (real
 *       streaming, NDJSON),</li>
 *   <li>validates the finished object,</li>
 *   <li>retries ONCE with the validation errors when the output is unusable,</li>
 *   <li>emits the validated reply — raw JSON is never shown to the user.</li>
 * </ol>
 *
 * <p>Wire format: newline-delimited JSON (NDJSON), one event per line, status
 * 200, {@code Content-Type: application/x-ndjson}, chunked,
 * {@code Cache-Control: no-cache, no-transform}. A caller that explicitly asks
 * for {@code application/json} (without a wildcard accept) instead gets the
 * plain JSON reply {@code {"reply": {…}}} — the client's non-stream fallback.
 *
 * <p>The whole turn is written on the servlet request thread, flushing after
 * every event, so nothing is buffered: the first sentence reaches the user
 * while the rest of the object is still generating.
 */
@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private static final Logger log = LoggerFactory.getLogger(ChatController.class);

    private final ChatSupport support;
    private final ChatStream stream;

    public ChatController(ChatSupport support, ChatStream stream) {
        this.support = support;
        this.stream = stream;
    }

    @PostMapping
    public void post(HttpServletRequest request, HttpServletResponse response) {
        try {
            // Read the raw body exactly like `await req.json()` does; a
            // missing/blank/malformed body becomes {} → transcript empty → 400.
            JsonNode body;
            try (InputStream in = request.getInputStream()) {
                body = Json.parseOrNull(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }

            ChatSupport.Parsed parsed = support.parse(body);
            if (parsed == null) {
                writeJson(response, HttpServletResponse.SC_BAD_REQUEST, error("Messages required"));
                return;
            }

            ChatSupport.Turn turn = support.prepare(parsed);

            if (!wantsNdjson(request.getHeader("Accept"))) {
                // Non-stream fallback (a pre-validated reply, never raw model output).
                runJson(turn, response);
                return;
            }

            response.setStatus(HttpServletResponse.SC_OK);
            response.setContentType("application/x-ndjson; charset=utf-8");
            response.setHeader("Cache-Control", "no-cache, no-transform");
            response.setHeader("X-Accel-Buffering", "no");
            OutputStream out = response.getOutputStream();
            stream.run(turn, new ChatStream.NdjsonSink(out));
        } catch (Exception error) {
            log.error("Chat error:", error);
            if (!response.isCommitted()) {
                ObjectNode node = Json.obj();
                node.put("error", "Failed to get response");
                node.put("details", "Something went wrong. Please try again.");
                try {
                    writeJson(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, node);
                } catch (IOException ignored) {
                    // Client went away — nothing left to write.
                }
            }
        }
    }

    /**
     * Content negotiation: no Accept header (or a wildcard one) streams NDJSON
     * exactly like the TS route, which never negotiated at all. Only a caller
     * that explicitly asks for {@code application/json} gets the plain reply.
     */
    private static boolean wantsNdjson(String accept) {
        if (accept == null || accept.isBlank()) {
            return true;
        }
        String header = accept.toLowerCase(Locale.ROOT);
        if (header.contains("application/x-ndjson")) {
            return true;
        }
        return !header.contains("application/json") || header.contains("*/*");
    }

    /**
     * JSON mode: run the very same turn with a collecting sink and answer
     * {@code 200 {"reply": {…}}} on success, {@code 500 {"error": …}} with the
     * TS failure wording otherwise.
     */
    private void runJson(ChatSupport.Turn turn, HttpServletResponse response) {
        AiReply[] done = {null};
        String[] failure = {null};
        stream.run(turn, new ChatStream.Sink() {
            @Override
            public void delta(String text) {
                // Deltas only exist for the NDJSON wire; the intro is part of done.reply.
            }

            @Override
            public void reset() {
            }

            @Override
            public void done(AiReply reply) {
                done[0] = reply;
            }

            @Override
            public void error(String message) {
                failure[0] = message;
            }
        });
        try {
            if (done[0] != null) {
                ObjectNode node = Json.obj();
                node.set("reply", Json.M.valueToTree(done[0]));
                writeJson(response, HttpServletResponse.SC_OK, node);
            } else if (failure[0] != null) {
                writeJson(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, error(failure[0]));
            } else {
                // Unreachable: a turn always ends in done or error.
                ObjectNode node = Json.obj();
                node.put("error", "Failed to get response");
                node.put("details", "Something went wrong. Please try again.");
                writeJson(response, HttpServletResponse.SC_INTERNAL_SERVER_ERROR, node);
            }
        } catch (IOException clientWentAway) {
            // Nothing left to write.
        }
    }

    private static ObjectNode error(String message) {
        ObjectNode node = Json.obj();
        node.put("error", message);
        return node;
    }

    private static void writeJson(HttpServletResponse response, int status, JsonNode node)
            throws IOException {
        byte[] bytes = Json.write(node).getBytes(StandardCharsets.UTF_8);
        response.setStatus(status);
        response.setContentType("application/json; charset=utf-8");
        response.setContentLength(bytes.length);
        OutputStream out = response.getOutputStream();
        out.write(bytes);
        out.flush();
    }
}
