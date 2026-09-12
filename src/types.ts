export interface UserRecord {
  password: string;
  createdAt: string;
}

export interface SessionRecord {
  username: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ChatMessage {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  read: boolean;
}

export interface Store {
  users: Record<string, UserRecord>;
  messages: ChatMessage[];
  sessions: Record<string, SessionRecord>;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export interface LastMessagePreview {
  content: string;
  timestamp: string;
  sender: string;
}

export interface UserSummary {
  username: string;
  unread: number;
  lastMessage: LastMessagePreview | null;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionToken?: string;
    }
  }
}

export {};
