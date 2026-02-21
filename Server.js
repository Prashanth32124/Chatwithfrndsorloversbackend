require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ================= MongoDB Connection ================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

/* ================= Schemas ================= */
const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String
}, { collection: "users" }));

const Friend = mongoose.model("Friend", new mongoose.Schema({
  userId: String,
  friendId: String
}, { collection: "friends" }));

const ChatSchema = new mongoose.Schema({
  conversationId: String,
  sender: String,
  receiver: String,
  message: String,
  time: { type: Date, default: Date.now }
}, { collection: "chats" });

ChatSchema.index({ conversationId: 1, time: -1 });
const Chat = mongoose.model("Chat", ChatSchema);

const Call = mongoose.model("Call", new mongoose.Schema({
  caller: String,
  receiver: String,
  channel: String,
  time: { type: Date, default: Date.now },
  status: { type: String, default: "ongoing" }
}, { collection: "calls" }));

/* ================= Auth Routes ================= */
app.post("/signup", async (req, res) => {
  try {
    let { name, email, password } = req.body;
    email = email.trim().toLowerCase();

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "User exists" });

    const user = await User.create({
      name: name.trim(),
      email,
      password: password.trim()
    });

    res.json({ message: "Signup success", userId: user._id });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({
    email: email.trim().toLowerCase(),
    password
  });

  if (!user) return res.status(400).json({ error: "Invalid login" });

  res.json({ message: "Login success", userId: user._id, name: user.name });
});

/* ================= Friend Routes ================= */
app.post("/add-friend", async (req, res) => {
  try {
    const { userId, friendId } = req.body;

    if (userId === friendId)
      return res.status(400).json({ error: "You cannot add yourself" });

    const exists = await Friend.findOne({ userId, friendId });
    if (exists) return res.json({ message: "Already friends" });

    await Friend.create({ userId, friendId });
    await Friend.create({ userId: friendId, friendId: userId });

    res.json({ message: "Friend added successfully" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/friends/:userId", async (req, res) => {
  try {
    const relations = await Friend.find({ userId: req.params.userId });
    const ids = relations.map(f => f.friendId);

    const friends = await User.find(
      { _id: { $in: ids } },
      { name: 1, email: 1 }
    );

    res.json(friends);
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/search-user", async (req, res) => {
  try {
    const email = req.query.email?.trim().toLowerCase();
    const user = await User.findOne({ email });

    if (!user)
      return res.status(404).json({ error: "User not found" });

    res.json({ userId: user._id, name: user.name, email: user.email });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= Chat Routes ================= */
app.get("/messages/:u1/:u2", async (req, res) => {
  try {
    const conversationId = [req.params.u1, req.params.u2].sort().join("_");
    const msgs = await Chat.find({ conversationId }).sort({ time: 1 });
    res.json(msgs);
  } catch {
    res.status(500).json({ error: "Failed to load messages" });
  }
});

/* ================= Call Routes ================= */
app.get("/call-history/:userId", async (req, res) => {
  try {
    const calls = await Call.find({
      $or: [
        { caller: req.params.userId },
        { receiver: req.params.userId }
      ]
    }).sort({ time: -1 });

    res.json(calls);
  } catch {
    res.status(500).json({ error: "Failed to load call history" });
  }
});

/* ================= Agora Token ================= */
app.get("/generate-token/:channel", (req, res) => {
  try {
    const appId = process.env.APP_ID;
    const cert = process.env.APP_CERTIFICATE;

    if (!appId || !cert) {
      console.log("❌ Missing Agora ENV");
      return res.status(500).json({ error: "Agora env missing" });
    }

    const expire = Math.floor(Date.now() / 1000) + 3600;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      cert,
      req.params.channel,
      0,
      RtcRole.PUBLISHER,
      expire
    );

    res.json({ token });

  } catch (err) {
    console.error("TOKEN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= SOCKET.IO ================= */
/* ================= SOCKET.IO ================= */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

/* Track active calls */
const activeCalls = new Map(); // channel -> Set(userIds)

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* ========== REGISTER USER ROOM ========== */
  socket.on("register", (userId) => {
    if (!userId) return;

    const room = userId.toString();
    socket.join(room);
    socket.userId = room;

    console.log("User joined personal room:", room);
  });

  /* ========== CHAT MESSAGE ========== */
  socket.on("send-message", async (data) => {
    try {
      if (!data?.sender || !data?.receiver || !data?.message) return;

      const sender = data.sender.toString();
      const receiver = data.receiver.toString();
      const conversationId = [sender, receiver].sort().join("_");

      const msg = await Chat.create({
        conversationId,
        sender,
        receiver,
        message: data.message.trim()
      });

      io.to(sender).emit("new-message", msg);
      io.to(receiver).emit("new-message", msg);

    } catch (err) {
      console.error("Message Error:", err);
    }
  });

  /* ========== CALL USER ========== */
  socket.on("call-user", async ({ to, from, channel }) => {
    try {
      await Call.create({ caller: from, receiver: to, channel });

      io.to(to.toString()).emit("incoming-call", { from, channel });

    } catch (err) {
      console.error("Call Error:", err);
    }
  });

  /* ========== JOIN CALL ROOM ========== */
  socket.on("join-call-room", (channel) => {
    if (!channel) return;

    socket.join(channel);

    if (!activeCalls.has(channel)) {
      activeCalls.set(channel, new Set());
    }

    activeCalls.get(channel).add(socket.id);
    socket.callChannel = channel;

    console.log(`📞 ${socket.id} joined call room: ${channel}`);

    socket.emit("joined-call-room");
  });

  /* ========== END CALL (BUTTON PRESS) ========== */
  socket.on("end-call", async ({ channel }) => {
    if (!channel) return;

    console.log("📴 Ending call for channel:", channel);

    try {
      await Call.updateMany(
        { channel, status: "ongoing" },
        { $set: { status: "ended" } }
      );
    } catch {}

    io.to(channel).emit("call-ended");

    activeCalls.delete(channel);
  });

  /* ========== AUTO END WHEN USER DISCONNECTS ========== */
  socket.on("disconnect", async () => {
    console.log("Socket disconnected:", socket.id);

    const channel = socket.callChannel;
    if (!channel) return;

    const room = activeCalls.get(channel);
    if (!room) return;

    room.delete(socket.id);

    // If only 0 or 1 left -> end call for everyone
    if (room.size <= 1) {
      console.log("📴 Auto ending call (user disconnected):", channel);

      io.to(channel).emit("call-ended");

      try {
        await Call.updateMany(
          { channel, status: "ongoing" },
          { $set: { status: "ended" } }
        );
      } catch {}

      activeCalls.delete(channel);
    }
  });
});
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));