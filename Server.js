require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

/* ================= MongoDB ================= */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));

/* ================= Schemas ================= */

// USERS → signup/login
const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String
}, { collection: "users" }));

// FRIENDS → friend list
const Friend = mongoose.model("Friend", new mongoose.Schema({
  userId: String,
  friendId: String
}, { collection: "friends" }));

// CHATS → messages
const Chat = mongoose.model("Chat", new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  time: { type: Date, default: Date.now }
}, { collection: "chats" }));

// CALL HISTORY → video calls
const Call = mongoose.model("Call", new mongoose.Schema({
  caller: String,
  receiver: String,
  channel: String,
  time: { type: Date, default: Date.now },
  status: { type: String, default: "ongoing" }
}, { collection: "calls" }));

/* ================= AUTH ================= */

app.post("/signup", async (req, res) => {
  try {
    let { name, email, password } = req.body;
    email = email.trim().toLowerCase();

    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ error: "User exists" });

    const user = await User.create({
      name: name.trim(),
      email,
      password: password.trim(),
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

  res.json({
    message: "Login success",
    userId: user._id,
    name: user.name
  });
});

/* ================= FRIENDS ================= */

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

/* ================= AGORA TOKEN ================= */

const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const APP_ID = "856700ed462044a1846e5f7379d2bcda";
const APP_CERTIFICATE = "4c624013656c4516899b986bf9673f4f";

app.get("/generate-token/:channel", (req, res) => {
  const channelName = req.params.channel;
  const uid = 0;
  const role = RtcRole.PUBLISHER;
  const expire = Math.floor(Date.now() / 1000) + 3600;

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    role,
    expire
  );

  res.json({ token });
});
/* ================= CHATS ================= */

app.post("/send-message", async (req, res) => {
  try {
    const { sender, receiver, message } = req.body;
    const msg = await Chat.create({ sender, receiver, message });
    res.json(msg);
  } catch {
    res.status(500).json({ error: "Message send failed" });
  }
});

app.get("/messages/:u1/:u2", async (req, res) => {
  try {
    const { u1, u2 } = req.params;

    const msgs = await Chat.find({
      $or: [
        { sender: u1, receiver: u2 },
        { sender: u2, receiver: u1 }
      ]
    }).sort({ time: 1 });

    res.json(msgs);
  } catch {
    res.status(500).json({ error: "Failed to load messages" });
  }
});

/* ================= CALL HISTORY ================= */

app.get("/call-history/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    const calls = await Call.find({
      $or: [{ caller: userId }, { receiver: userId }]
    }).sort({ time: -1 });

    res.json(calls);
  } catch {
    res.status(500).json({ error: "Failed to load call history" });
  }
});
/* ================= SOCKET ================= */

const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });

let onlineUsers = {};

io.on("connection", (socket) => {

  socket.on("register", (userId) => {
    onlineUsers[userId] = socket.id;
    socket.join(userId);              // 🔥 Added (personal room)
    console.log("User online:", userId);
  });

  // 🔥 Added (join call room)
  socket.on("join-call-room", (channel) => {
    socket.join(channel);
  });

  socket.on("call-user", async ({ to, channel, from }) => {
    const target = onlineUsers[to];

    await Call.create({
      caller: from,
      receiver: to,
      channel,
      status: "ongoing"
    });

    if (target) {
      io.to(target).emit("incoming-call", { from, channel });
    }
  });

  socket.on("end-call", async ({ channel }) => {
    await Call.findOneAndUpdate(
      { channel, status: { $ne: "ended" } },
      { status: "ended" }
    );

    // 🔥 Your existing logic
    const users = channel.split("_");
    users.forEach(userId => {
      const target = onlineUsers[userId];
      if (target) {
        io.to(target).emit("call-ended");
      }
    });

    // 🔥 EXTRA reliable broadcast
    io.to(channel).emit("call-ended");

    console.log("Call ended:", channel);
  });

  socket.on("disconnect", () => {
    for (let id in onlineUsers) {
      if (onlineUsers[id] === socket.id) {
        delete onlineUsers[id];
        console.log("User offline:", id);
      }
    }
  });
});

/* ================= START ================= */

const PORT = process.env.PORT || 5000;
http.listen(PORT, () => {
  console.log(`Server + Socket running on ${PORT}`);
});