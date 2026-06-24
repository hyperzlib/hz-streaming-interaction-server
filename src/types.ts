export type MemberPresence = "online" | "offline";

export type RoomCloseReason = "manual" | "owner_offline" | "empty_room" | "server_shutdown";

export type RoomClosedPayload = {
  roomId: string;
  reason: RoomCloseReason;
  closedAt: number;
};

export type Member = {
  sessionId: string;
  role: "host" | "participant";
  userId?: string;
  joinedAt: number;
  lastSeenAt: number;
  presence: MemberPresence;
};

export type RoomMeta = {
  roomId: string;
  roomType: string;
  ownerId: string;
  isPublicRead: boolean;
  passwordHash?: string | null;
  createdAt: number;
  closedAt?: number | null;
  closedReason?: RoomCloseReason | null;
};

export type RoomState = {
  members: Record<string, Member>;
} & Record<string, unknown>;

export type Session = {
  sessionId: string;
  roomId: string;
  role: "host" | "participant";
  userId?: string;
};

export type RoomEvent = {
  roomId: string;
  type: string;
  payload: unknown;
  seq: number;
  timestamp: number;
};

export type DispatchRequest = {
  roomId: string;
  roomMeta: RoomMeta;
  eventType: string;
  payload: unknown;
};

export type EventContext = {
  roomId: string;
  roomMeta: RoomMeta;
  session: Session;
  broadcast: (event: Omit<RoomEvent, "roomId" | "seq" | "timestamp">) => Promise<void>;
  state: RoomState;
};

export type ClientCommand = {
  id: string;
  type: string;
  roomId: string;
  payload: unknown;
};
