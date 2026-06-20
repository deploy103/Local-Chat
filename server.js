const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const multer = require("multer");
const { DatabaseSync } = require("node:sqlite");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "chat.sqlite");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMP_UPLOAD_DIR = path.join(UPLOAD_DIR, ".tmp");
const ROOM_CODE_PATTERN = /^\d{4}$/;
const MAX_FILES_PER_UPLOAD = 10;
const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_REQUEST_BYTES = MAX_TOTAL_UPLOAD_BYTES + 1024 * 1024;
const FILE_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_LIMIT = 500;
const TEXT_LIMIT = 2000;

fsSync.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    owner_ip TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    uploaded_by_ip TEXT NOT NULL,
    disk_path TEXT NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    type TEXT NOT NULL,
    sender_ip TEXT,
    text TEXT NOT NULL,
    file_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages(room_code, created_at);

  CREATE INDEX IF NOT EXISTS idx_files_room_expires
    ON files(room_code, expires_at);
`);

const presenceByRoom = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1024 * 1024,
});

const upload = multer({
  storage: multer.diskStorage({
    destination: TEMP_UPLOAD_DIR,
    filename: (req, file, done) => done(null, crypto.randomUUID()),
  }),
  limits: {
    files: MAX_FILES_PER_UPLOAD,
    fileSize: MAX_TOTAL_UPLOAD_BYTES,
  },
});

app.set("trust proxy", true);
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

function normalizeIp(ip) {
  return String(ip || "unknown")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
}

function getRequestIp(req) {
  return normalizeIp(req.headers["x-forwarded-for"] || req.ip || req.socket.remoteAddress);
}

function getSocketIp(socket) {
  return normalizeIp(
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address
  );
}

function sanitizeRoomCode(value) {
  const code = String(value || "").trim();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

function sanitizeFileName(name) {
  const rawName = String(name || "file");
  const utf8Name = Buffer.from(rawName, "latin1").toString("utf8");
  const normalizedName = utf8Name.includes("\uFFFD") ? rawName : utf8Name;
  const cleaned = normalizedName
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160) || "file";
}

function getRoom(code) {
  return (
    db
      .prepare(
        `SELECT code, owner_ip AS ownerIp, created_at AS createdAt
         FROM rooms
         WHERE code = ?`
      )
      .get(code) || null
  );
}

function roomExists(code) {
  return Boolean(db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code));
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (!roomExists(code)) {
      return code;
    }
  }
  throw new Error("사용 가능한 방 코드가 없습니다.");
}

function getCount(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(row?.count || 0);
}

function getPresenceState(roomCode) {
  let state = presenceByRoom.get(roomCode);
  if (!state) {
    state = {
      sockets: new Map(),
      typingByIp: new Map(),
    };
    presenceByRoom.set(roomCode, state);
  }
  return state;
}

function getPresence(room) {
  const state = presenceByRoom.get(room.code);
  if (!state) {
    return [];
  }

  const usersByIp = new Map();
  for (const user of state.sockets.values()) {
    const current = usersByIp.get(user.ip);
    if (!current) {
      usersByIp.set(user.ip, {
        ip: user.ip,
        sockets: 1,
        joinedAt: user.joinedAt,
        isOwner: room.ownerIp === user.ip,
      });
      continue;
    }
    current.sockets += 1;
    current.joinedAt = Math.min(current.joinedAt, user.joinedAt);
  }
  return [...usersByIp.values()].sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
}

function publicRoom(room, ip) {
  return {
    code: room.code,
    ownerIp: room.ownerIp,
    createdAt: room.createdAt,
    userCount: getPresence(room).length,
    messageCount: getCount("SELECT COUNT(*) AS count FROM messages WHERE room_code = ?", room.code),
    fileCount: getCount(
      "SELECT COUNT(*) AS count FROM files WHERE room_code = ? AND expires_at > ?",
      room.code,
      Date.now()
    ),
    isOwner: room.ownerIp === ip,
  };
}

function mapFileRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    roomCode: row.roomCode,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    uploadedAt: row.uploadedAt,
    expiresAt: row.expiresAt,
    uploadedByIp: row.uploadedByIp,
    diskPath: row.diskPath,
  };
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    uploadedAt: file.uploadedAt,
    expiresAt: file.expiresAt,
    uploadedByIp: file.uploadedByIp,
    downloadUrl: `/api/rooms/${file.roomCode}/files/${file.id}/download`,
  };
}

function getActiveFiles(roomCode) {
  return db
    .prepare(
      `SELECT id,
              room_code AS roomCode,
              name,
              size,
              mime_type AS mimeType,
              uploaded_at AS uploadedAt,
              expires_at AS expiresAt,
              uploaded_by_ip AS uploadedByIp,
              disk_path AS diskPath
       FROM files
       WHERE room_code = ? AND expires_at > ?
       ORDER BY uploaded_at ASC`
    )
    .all(roomCode, Date.now())
    .map(mapFileRow)
    .map(publicFile);
}

function getFile(roomCode, fileId) {
  return mapFileRow(
    db
      .prepare(
        `SELECT id,
                room_code AS roomCode,
                name,
                size,
                mime_type AS mimeType,
                uploaded_at AS uploadedAt,
                expires_at AS expiresAt,
                uploaded_by_ip AS uploadedByIp,
                disk_path AS diskPath
         FROM files
         WHERE room_code = ? AND id = ?`
      )
      .get(roomCode, fileId)
  );
}

function getRecentMessages(roomCode) {
  return db
    .prepare(
      `SELECT m.id,
              m.room_code AS roomCode,
              m.type,
              m.sender_ip AS senderIp,
              m.text,
              m.created_at AS createdAt,
              f.id AS fileId,
              f.room_code AS fileRoomCode,
              f.name AS fileName,
              f.size AS fileSize,
              f.mime_type AS fileMimeType,
              f.uploaded_at AS fileUploadedAt,
              f.expires_at AS fileExpiresAt,
              f.uploaded_by_ip AS fileUploadedByIp,
              f.disk_path AS fileDiskPath
       FROM (
         SELECT *
         FROM messages
         WHERE room_code = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) m
       LEFT JOIN files f ON f.id = m.file_id
       ORDER BY m.created_at ASC`
    )
    .all(roomCode, MESSAGE_LIMIT)
    .map((row) => {
      const message = {
        id: row.id,
        roomCode: row.roomCode,
        type: row.type,
        senderIp: row.senderIp,
        text: row.text,
        createdAt: row.createdAt,
      };
      if (row.fileId) {
        message.file = publicFile({
          id: row.fileId,
          roomCode: row.fileRoomCode,
          name: row.fileName,
          size: row.fileSize,
          mimeType: row.fileMimeType,
          uploadedAt: row.fileUploadedAt,
          expiresAt: row.fileExpiresAt,
          uploadedByIp: row.fileUploadedByIp,
          diskPath: row.fileDiskPath,
        });
      }
      return message;
    });
}

function pruneRoomMessages(roomCode) {
  db.prepare(
    `DELETE FROM messages
     WHERE room_code = ?
       AND id NOT IN (
         SELECT id
         FROM messages
         WHERE room_code = ?
         ORDER BY created_at DESC
         LIMIT ?
       )`
  ).run(roomCode, roomCode, MESSAGE_LIMIT);
}

function addMessage(roomCode, message) {
  const saved = {
    id: crypto.randomUUID(),
    roomCode,
    createdAt: Date.now(),
    type: message.type,
    senderIp: message.senderIp || null,
    text: message.text || "",
    file: message.file,
  };

  db.prepare(
    `INSERT INTO messages (id, room_code, type, sender_ip, text, file_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    saved.id,
    saved.roomCode,
    saved.type,
    saved.senderIp,
    saved.text,
    message.fileId || null,
    saved.createdAt
  );
  pruneRoomMessages(roomCode);

  io.to(roomCode).emit("messageCreated", saved);
  return saved;
}

function createRoom(ownerIp) {
  const code = generateRoomCode();
  const createdAt = Date.now();
  db.prepare("INSERT INTO rooms (code, owner_ip, created_at) VALUES (?, ?, ?)").run(
    code,
    ownerIp,
    createdAt
  );
  addMessage(code, {
    type: "system",
    text: "방이 생성되었습니다.",
  });
  return { code, ownerIp, createdAt };
}

async function removeRoomFiles(roomCode) {
  const roomDir = path.join(UPLOAD_DIR, roomCode);
  await fs.rm(roomDir, { recursive: true, force: true });
}

async function cleanupUploadedFiles(files = []) {
  await Promise.all(
    files
      .filter((file) => file?.path)
      .map((file) => fs.rm(file.path, { force: true }).catch(() => {}))
  );
}

async function destroyRoom(room, destroyedByIp) {
  io.to(room.code).emit("roomDestroyed", {
    roomCode: room.code,
    destroyedByIp,
    destroyedAt: Date.now(),
  });

  const presence = presenceByRoom.get(room.code);
  if (presence) {
    for (const socketId of presence.sockets.keys()) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.leave(room.code);
        socket.data.roomCode = null;
      }
    }
  }

  presenceByRoom.delete(room.code);
  db.prepare("DELETE FROM rooms WHERE code = ?").run(room.code);
  await removeRoomFiles(room.code);
}

function emitPresence(room) {
  io.to(room.code).emit("presenceChanged", {
    roomCode: room.code,
    users: getPresence(room),
  });
}

function leaveSocketRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) {
    return;
  }

  const room = getRoom(code);
  const presence = presenceByRoom.get(code);
  if (!presence) {
    socket.data.roomCode = null;
    return;
  }

  presence.sockets.delete(socket.id);
  presence.typingByIp.delete(socket.data.ip);
  socket.leave(code);
  socket.data.roomCode = null;

  if (presence.sockets.size === 0 && !room) {
    presenceByRoom.delete(code);
  }
  if (room) {
    emitPresence(room);
  }
}

function handleUpload(req, res, next) {
  upload.array("files", MAX_FILES_PER_UPLOAD)(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    cleanupUploadedFiles(req.files).catch(() => {});
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_COUNT"
          ? "한 번에 최대 10개까지 업로드할 수 있습니다."
          : "한 번에 최대 100MB까지 업로드할 수 있습니다.";
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  });
}

function rejectLargeUploadRequest(req, res, next) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    res.status(413).json({ error: "한 번에 최대 100MB까지 업로드할 수 있습니다." });
    return;
  }
  next();
}

function loadRoom(req, res, next) {
  const code = sanitizeRoomCode(req.params.code);
  const room = code ? getRoom(code) : null;
  if (!room) {
    res.status(404).json({ error: "방을 찾을 수 없습니다." });
    return;
  }
  req.roomCode = code;
  req.chatRoom = room;
  next();
}

app.get("/api/me", (req, res) => {
  res.json({ ip: getRequestIp(req) });
});

app.post("/api/rooms", (req, res) => {
  const ip = getRequestIp(req);
  const room = createRoom(ip);
  res.status(201).json({ room: publicRoom(room, ip) });
});

app.get("/api/rooms/:code", (req, res) => {
  const code = sanitizeRoomCode(req.params.code);
  const room = code ? getRoom(code) : null;
  if (!room) {
    res.status(404).json({ error: "방을 찾을 수 없습니다." });
    return;
  }
  res.json({ room: publicRoom(room, getRequestIp(req)) });
});

app.post("/api/rooms/:code/destroy", loadRoom, async (req, res, next) => {
  const room = req.chatRoom;
  const ip = getRequestIp(req);
  if (room.ownerIp !== ip) {
    res.status(403).json({ error: "방장만 방을 터뜨릴 수 있습니다." });
    return;
  }

  try {
    await destroyRoom(room, ip);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:code/files", loadRoom, rejectLargeUploadRequest, handleUpload, async (req, res, next) => {
  const room = req.chatRoom;
  const files = req.files || [];
  if (files.length === 0) {
    res.status(400).json({ error: "업로드할 파일을 선택해주세요." });
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_FILES_PER_UPLOAD || totalSize > MAX_TOTAL_UPLOAD_BYTES) {
    await cleanupUploadedFiles(files);
    res.status(400).json({ error: "한 번에 최대 10개, 총 100MB까지 업로드할 수 있습니다." });
    return;
  }

  const movedFiles = [];
  try {
    const ip = getRequestIp(req);
    const roomDir = path.join(UPLOAD_DIR, room.code);
    await fs.mkdir(roomDir, { recursive: true });

    const uploaded = [];
    for (const file of files) {
      const id = crypto.randomUUID();
      const safeName = sanitizeFileName(file.originalname);
      const diskPath = path.join(roomDir, id);
      const uploadedAt = Date.now();
      const record = {
        id,
        roomCode: room.code,
        name: safeName,
        size: file.size,
        mimeType: file.mimetype || "application/octet-stream",
        uploadedAt,
        expiresAt: uploadedAt + FILE_TTL_MS,
        uploadedByIp: ip,
        diskPath,
      };

      await fs.rename(file.path, diskPath);
      movedFiles.push(diskPath);
      db.prepare(
        `INSERT INTO files (
           id,
           room_code,
           name,
           size,
           mime_type,
           uploaded_at,
           expires_at,
           uploaded_by_ip,
           disk_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.roomCode,
        record.name,
        record.size,
        record.mimeType,
        record.uploadedAt,
        record.expiresAt,
        record.uploadedByIp,
        record.diskPath
      );

      const visibleFile = publicFile(record);
      uploaded.push(visibleFile);
      addMessage(room.code, {
        type: "file",
        senderIp: ip,
        text: `${safeName} 파일을 업로드했습니다.`,
        fileId: record.id,
        file: visibleFile,
      });
    }

    res.status(201).json({ files: uploaded });
  } catch (error) {
    await cleanupUploadedFiles(files);
    await Promise.all(movedFiles.map((filePath) => fs.rm(filePath, { force: true })));
    next(error);
  }
});

app.get("/api/rooms/:code/files/:fileId/download", async (req, res, next) => {
  const code = sanitizeRoomCode(req.params.code);
  const room = code ? getRoom(code) : null;
  const file = room ? getFile(code, req.params.fileId) : null;
  if (!room || !file) {
    res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    return;
  }
  if (file.expiresAt <= Date.now()) {
    await expireFile(file);
    res.status(410).json({ error: "만료된 파일입니다." });
    return;
  }

  res.download(file.diskPath, file.name, (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

io.on("connection", (socket) => {
  const ip = getSocketIp(socket);

  socket.on("joinRoom", ({ roomCode } = {}) => {
    const code = sanitizeRoomCode(roomCode);
    const room = code ? getRoom(code) : null;
    if (!room) {
      socket.emit("errorMessage", "방을 찾을 수 없습니다.");
      return;
    }

    if (socket.data.roomCode && socket.data.roomCode !== code) {
      leaveSocketRoom(socket);
    }

    const presence = getPresenceState(code);
    socket.data.roomCode = code;
    socket.data.ip = ip;
    socket.join(code);
    presence.sockets.set(socket.id, {
      ip,
      joinedAt: Date.now(),
    });

    socket.emit("roomJoined", {
      room: publicRoom(room, ip),
      messages: getRecentMessages(code),
      files: getActiveFiles(code),
      users: getPresence(room),
      me: { ip },
    });
    emitPresence(room);
  });

  socket.on("sendMessage", ({ text } = {}) => {
    const code = socket.data.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) {
      socket.emit("errorMessage", "먼저 방에 입장해주세요.");
      return;
    }

    const cleaned = String(text || "").trim();
    if (!cleaned) {
      return;
    }
    if (cleaned.length > TEXT_LIMIT) {
      socket.emit("errorMessage", `메시지는 ${TEXT_LIMIT}자까지 보낼 수 있습니다.`);
      return;
    }

    addMessage(room.code, {
      type: "text",
      senderIp: socket.data.ip || ip,
      text: cleaned,
    });
  });

  socket.on("typing", ({ isTyping } = {}) => {
    const code = socket.data.roomCode;
    const room = code ? getRoom(code) : null;
    const presence = code ? presenceByRoom.get(code) : null;
    if (!room || !presence) {
      return;
    }

    const typingIp = socket.data.ip || ip;
    if (isTyping) {
      presence.typingByIp.set(typingIp, Date.now());
    } else {
      presence.typingByIp.delete(typingIp);
    }
    const typingUsers = [...presence.typingByIp.keys()];
    socket.to(code).emit("typingChanged", { roomCode: code, users: typingUsers });
  });

  socket.on("leaveRoom", () => {
    leaveSocketRoom(socket);
  });

  socket.on("destroyRoom", async () => {
    const code = socket.data.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) {
      socket.emit("errorMessage", "방을 찾을 수 없습니다.");
      return;
    }
    const requesterIp = socket.data.ip || ip;
    if (room.ownerIp !== requesterIp) {
      socket.emit("errorMessage", "방장만 방을 터뜨릴 수 있습니다.");
      return;
    }
    try {
      await destroyRoom(room, requesterIp);
    } catch (error) {
      socket.emit("errorMessage", "방을 터뜨리는 중 오류가 발생했습니다.");
    }
  });

  socket.on("disconnect", () => {
    leaveSocketRoom(socket);
  });
});

async function expireFile(file) {
  db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
  await fs.rm(file.diskPath, { force: true });
  io.to(file.roomCode).emit("fileExpired", {
    roomCode: file.roomCode,
    fileId: file.id,
  });

  if (getRoom(file.roomCode)) {
    addMessage(file.roomCode, {
      type: "system",
      text: `${file.name} 파일이 만료되어 삭제되었습니다.`,
    });
  }
}

async function cleanupExpiredFiles() {
  const files = db
    .prepare(
      `SELECT id,
              room_code AS roomCode,
              name,
              size,
              mime_type AS mimeType,
              uploaded_at AS uploadedAt,
              expires_at AS expiresAt,
              uploaded_by_ip AS uploadedByIp,
              disk_path AS diskPath
       FROM files
       WHERE expires_at <= ?`
    )
    .all(Date.now())
    .map(mapFileRow);

  for (const file of files) {
    await expireFile(file);
  }
}

setInterval(() => {
  cleanupExpiredFiles().catch((error) => {
    console.error("Expired file cleanup failed:", error);
  });
}, 60 * 1000);

app.use((error, req, res, next) => {
  console.error(error);
  cleanupUploadedFiles(req.files).catch(() => {});
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

async function startServer() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  await cleanupExpiredFiles();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Local Chat running at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
