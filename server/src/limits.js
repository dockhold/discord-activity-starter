// Every bound the server enforces, in one place. Raise them in code as your
// Activity grows; the tests read the same values.

export const LIMITS = Object.freeze({
  // Our session token, handed out by POST /api/token and shown on the socket.
  sessionTtlMs: 15 * 60 * 1000,

  // POST /api/token. Discord's proxy hides the player's address, so there is
  // no per-player key: each authorization code gets a few tries, and all
  // sign-ins together share one budget (a burst, refilled at a steady rate).
  tokenBodyBytes: 2048,
  tokenTriesPerCode: 3,
  tokenCodeWindowMs: 10 * 60 * 1000,
  tokenGlobalBurst: 120,
  tokenGlobalPerSecond: 2,
  discordTimeoutMs: 10 * 1000,

  // The WebSocket. A socket signs in during the handshake, so every open
  // socket belongs to a signed-in player.
  maxMessageBytes: 4 * 1024, // bigger messages close the socket (1009)
  maxMessagesPerSecond: 20, // more close the socket (1008)
  maxSockets: 1000, // all open sockets
  maxRooms: 200,
  maxSocketsPerRoom: 50,
  maxSocketsPerUser: 6, // across all rooms
  maxSocketsPerUserPerRoom: 3,
  closeGraceMs: 1000, // a refused socket that ignores our close frame is cut
  maxBufferedBytes: 1024 * 1024, // a reader this far behind is dropped
  pingIntervalMs: 25 * 1000, // application ping, answered by the client
  idleTimeoutMs: 60 * 1000, // no message for this long ends the socket
  emptyRoomTtlMs: 60 * 1000, // an empty room keeps its game this long

  // Shutdown: open sockets get a close frame, then this long to go.
  shutdownGraceMs: 2 * 1000,
});
