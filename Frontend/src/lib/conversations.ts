import { generateId, type Message } from "./chat";
import { EMPTY_PROFILE, type TripProfile } from "./tripProfile";

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  profile: TripProfile;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "tripcraft_conversations";

export function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: Conversation) => ({
      ...c,
      profile: { ...EMPTY_PROFILE, ...(c.profile || {}) },
      messages: Array.isArray(c.messages) ? c.messages : [],
    }));
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // storage full — drop oldest half
    try {
      const trimmed = conversations.slice(0, Math.floor(conversations.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // give up silently
    }
  }
}

export function createConversation(
  messages: Message[] = [],
  profile: TripProfile = EMPTY_PROFILE
): Conversation {
  const now = Date.now();
  return {
    id: generateId() + "-" + now.toString(36),
    title: deriveTitle(messages),
    messages,
    profile: { ...EMPTY_PROFILE, ...profile },
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New trip";
  const text = firstUser.content.replace(/\s+/g, " ").trim();
  return text.length > 42 ? text.slice(0, 42) + "…" : text;
}
