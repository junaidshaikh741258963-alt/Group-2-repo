"use client";

import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  variant?: "default" | "hero";
  /** Trip tools revealed by the plus button (see ChatQuickActions). */
  actions?: ReactNode;
}

/** Minimal shape of the Web Speech API, which is not in the DOM lib. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * One floating composer, like the chat app it lives in: a plus for trip tools,
 * the message field, voice, and a white send disc. The field grows with the
 * text; Enter sends, Shift+Enter breaks the line. The capability rail is one
 * tap behind the plus instead of a permanent second toolbar.
 */
export default function ChatInput({
  onSend,
  disabled,
  placeholder,
  autoFocus,
  className = "",
  variant = "default",
  actions,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isHero = variant === "hero";
  const canSend = message.trim().length > 0 && !disabled;

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Grow with the content, up to a cap; never animate the height itself (that
  // fights the caret while typing).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, isHero ? 180 : 148) + "px";
  }, [message, isHero]);

  useEffect(
    () => () => {
      recognitionRef.current?.stop();
    },
    []
  );

  const handleSubmit = useCallback(() => {
    const text = message.trim();
    if (!text || disabled) return;
    onSend(text);
    setMessage("");
    setToolsOpen(false);
    textareaRef.current?.focus({ preventScroll: true });
  }, [message, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing protects IME input (Chinese/Japanese/Korean): Enter there
    // confirms a candidate, it does not send the message.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const toggleVoice = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = getRecognition();
    if (!recognition) return;
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length }, (_, i) => event.results[i][0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) {
        setMessage((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  }, [listening]);

  return (
    <div className={`w-full ${className}`}>
      <div className="relative rounded-[20px] border border-white/[0.1] bg-[#151517] shadow-[0_18px_44px_-28px_rgba(0,0,0,0.95)] transition-colors focus-within:border-white/[0.2]">
        {toolsOpen && actions && (
          <div className="border-b border-white/[0.07] px-2 py-2">{actions}</div>
        )}
        <div className={`flex items-end gap-2 ${isHero ? "px-2 py-2" : "px-2 py-2"}`}>
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            aria-expanded={toolsOpen}
            aria-label={toolsOpen ? "Hide trip tools" : "Show trip tools"}
            title="Trip tools"
            className={`mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${
              toolsOpen ? "bg-white/[0.1] text-white" : ""
            }`}
          >
            <svg
              className={`h-4 w-4 transition-transform duration-200 ${toolsOpen ? "rotate-45" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path strokeLinecap="round" d="M12 5v14M5 12h14" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || "Ask a question"}
            disabled={disabled}
            rows={1}
            aria-label="Message TripCraft"
            aria-keyshortcuts="Enter"
            autoComplete="off"
            spellCheck
            className={[
              "max-h-37 min-h-8 flex-1 resize-none bg-transparent text-[15px] leading-6 text-ink",
              "placeholder-zinc-500 outline-none [overflow-wrap:anywhere] disabled:opacity-60",
              "max-md:text-base",
              isHero ? "px-1 py-1" : "px-1 py-1",
            ].join(" ")}
          />

          <button
            type="button"
            onClick={toggleVoice}
            aria-label={listening ? "Stop voice input" : "Use voice input"}
            title={listening ? "Stop voice input" : "Use voice input"}
            className={`mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${
              listening ? "bg-red-500/15 text-red-300" : "text-zinc-400"
            }`}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              viewBox="0 0 24 24"
              aria-hidden
            >
              <rect x="9" y="2.5" width="6" height="12" rx="3" />
              <path strokeLinecap="round" d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
            </svg>
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSend}
            aria-label="Send message"
            className={[
              "mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[transform,background-color,color] duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
              canSend
                ? "bg-white text-zinc-900 hover:bg-zinc-200 active:scale-90"
                : "bg-white/[0.08] text-zinc-500",
            ].join(" ")}
          >
            {disabled && message.trim() ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
            ) : (
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.2}
                  d="M12 19V5M6 11l6-6 6 6"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      <p className="mt-2 text-center text-3xs leading-relaxed text-zinc-500">
        TripCraft can make mistakes. Check important info.
      </p>
    </div>
  );
}

const SUGGESTIONS = [
  "Where should I go in October?",
  "Find live flights to Tokyo",
  "A food-first weekend in Lisbon",
  "Plan 5 days in Kyoto",
];

export function SuggestionChips({ onSelect }: { onSelect: (s: string) => void }) {
  return (
    <div className="mx-auto grid w-full grid-cols-1 gap-2 min-[560px]:grid-cols-2">
      {SUGGESTIONS.map((label) => (
        <button
          key={label}
          onClick={() => onSelect(label)}
          className="group/chip flex h-9 items-center justify-center gap-1.5 rounded-full border border-white/[0.09] bg-white/[0.03] px-4 text-xs text-zinc-400 transition-colors hover:border-white/[0.18] hover:bg-white/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        >
          <span className="truncate">{label}</span>
          <span
            aria-hidden
            className="shrink-0 text-zinc-600 transition-all duration-200 group-hover/chip:translate-x-0.5 group-hover/chip:text-zinc-300"
          >
            →
          </span>
        </button>
      ))}
    </div>
  );
}
