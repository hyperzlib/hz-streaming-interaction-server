import type { RoomState } from "./storage/room-state";

export type MemberPresence = "online" | "offline";

export type RoomCloseReason = "manual" | "owner_offline" | "empty_room" | "server_shutdown";

export type RoomClosedPayload = {
  roomId: string;
  reason: RoomCloseReason;
  closedAt: number;
};

export type Member = {
  sessionId: string;
  role: "host" | "participant" | "guest";
  roomUserId: string;
  roomUserName?: string;
  userId?: string;
  joinedAt: number;
  lastSeenAt: number;
  presence: MemberPresence;
};

export type RoomMeta = {
  roomId: string;
  roomType: string;
  ownerId: string;
  allowGuest: boolean;
  passwordHash?: string | null;
  createdAt: number;
  closedAt?: number | null;
  closedReason?: RoomCloseReason | null;
};

export type RoomStateSnapshot = {
  members: Record<string, Member>;
} & Record<string, unknown>;

export type Session = {
  sessionId: string;
  roomId: string;
  role: "host" | "participant" | "guest";
  roomUserId: string;
  roomUserName?: string;
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

export type BroadcastOpts = {
  excludeGuests?: boolean;
};

export type EventContext = {
  roomId: string;
  roomMeta: RoomMeta;
  session: Session;
  send: (event: Omit<RoomEvent, "roomId" | "seq" | "timestamp">) => Promise<void>;
  broadcast: (event: Omit<RoomEvent, "roomId" | "seq" | "timestamp">, opts?: BroadcastOpts) => Promise<void>;
  state: RoomState;
};

export type ClientCommand = {
  id: string;
  type: string;
  roomId: string;
  payload: unknown;
};
