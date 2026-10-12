require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const bigInt = require("big-integer");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();
const port = process.env.PORT || 10000;

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
// সেশন স্ট্রিংয়ের ভেতরের অপ্রয়োজনীয় স্পেস ট্রিম করা
const rawSession = (process.env.SESSION_STRING || "").trim();
const session = new StringSession(rawSession);
const CHANNEL_ID = BigInt(process.env.CHANNEL_ID);

// ক্লাউড ডক ও রেন্ডার ফায়ারওয়াল বাইপাস কনফিগারেশন (WSS + Secure Ports)
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 15,
  retryDelay: 3000,
  autoReconnect: true,
  useWSS: true, // ক্লাউডে পোর্ট ৮০ ব্লকের বদলে সিকিউর ৪৪৩ পোর্ট দিয়ে কানেক্ট হবে
  timeout: 30000,
});

let isClientConnected = false;

async function getConnectedClient() {
  if (!isClientConnected) {
    try {
      await client.connect();
      isClientConnected = true;
      console.log("Telegram Client connected securely via Cloud.");
    } catch (err) {
      console.error("Telegram Connection Error:", err.message);
    }
  }
  return client;
}

// ক্যাপশন পার্স করার লজিক
function parseCaption(text, fallbackFileName, msgId) {
  if (!text) {
    return {
      title: fallbackFileName || `Video #${msgId}`,
      categories: ["#uncategorized"],
    };
  }

  let mainTitle = "";
  const titleMatch = text.match(/Title\s*🎬?\s*:\s*([^\n\r]+)/i);
  if (titleMatch && titleMatch[1]) {
    mainTitle = titleMatch[1].trim();
  }

  let seriesInfo = "";
  const seriesMatch = text.match(/Series\s*Info[^\w\n\r:]*[:#]\s*([^\n\r]+)/i);
  if (seriesMatch && seriesMatch[1]) {
    seriesInfo = seriesMatch[1].trim();
  }

  let finalTitle = "";
  if (mainTitle && seriesInfo) {
    finalTitle = `${mainTitle} - ${seriesInfo}`;
  } else if (mainTitle) {
    finalTitle = mainTitle;
  } else if (seriesInfo) {
    finalTitle = seriesInfo;
  } else {
    const firstLine = text.split("\n")[0].trim();
    finalTitle = firstLine.length > 0 ? firstLine : (fallbackFileName || `Video #${msgId}`);
  }

  const tagMatches = text.match(/#[a-zA-Z0-9_]+/g);
  let categories = tagMatches ? tagMatches.map((t) => t.toLowerCase()) : ["#others"];

  return { title: finalTitle, categories };
}

function getIndexedVideos() {
  if (fs.existsSync("videos.json")) {
    try {
      return JSON.parse(fs.readFileSync("videos.json", "utf8"));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveIndexedVideos(data) {
  try {
    fs.writeFileSync("videos.json", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Save error:", e.message);
  }
}

// ব্যাকগ্রাউন্ড অটো-সিঙ্ক
let lastCheckTime = 0;
async function syncLatestVideos() {
  const now = Date.now();
  if (now - lastCheckTime < 60 * 1000) return;
  lastCheckTime = now;

  try {
    const tg = await getConnectedClient();
    const latestMessages = await tg.getMessages(CHANNEL_ID, { limit: 10 });
    const currentVideos = getIndexedVideos();
    let hasNew = false;

    for (const msg of latestMessages) {
      if (msg.media && msg.media.document) {
        const doc = msg.media.document;
        const mime = doc.mimeType || "";
        const isVideo =
          mime.startsWith("video/") ||
          mime === "application/x-tgvideo" ||
          (doc.attributes && doc.attributes.some((a) => a.className === "DocumentAttributeVideo"));

        if (isVideo && !currentVideos.some((v) => v.id === msg.id)) {
          const fileAttr = doc.attributes.find((a) => a.fileName);
          const rawFileName = fileAttr ? fileAttr.fileName : "";
          const parsed = parseCaption(msg.message, rawFileName, msg.id);

          currentVideos.unshift({
            id: msg.id,
            title: parsed.title,
            caption: msg.message || "",
            categories: parsed.categories,
            size: Number(doc.size),
            mimeType: mime,
            date: msg.date,
          });
          hasNew = true;
        }
      }
    }

    if (hasNew) {
      saveIndexedVideos(currentVideos);
      console.log("[Auto-Sync] New video(s) added successfully.");
    }
  } catch (e) {
    console.error("Sync warning:", e.message);
  }
}

// সার্ভার চালু হওয়ার সাথে কানেকশন ইনিশিয়ালাইজ
getConnectedClient();

app.use(express.static(path.join(__dirname, "public")));

// ১. ভিডিও লিস্ট ও পেজিনেশন API
app.get("/api/videos", async (req, res) => {
  syncLatestVideos();

  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const category = (req.query.category || "ALL").toLowerCase();

  let videos = getIndexedVideos();

  if (category !== "all") {
    videos = videos.filter((v) =>
      v.categories && v.categories.some((c) => c.toLowerCase() === category)
    );
  }

  const total = videos.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const startIndex = (page - 1) * limit;
  const paginated = videos.slice(startIndex, startIndex + limit);

  const allCategories = new Set();
  getIndexedVideos().forEach((v) => {
    if (v.categories) v.categories.forEach((c) => allCategories.add(c));
  });

  res.json({
    total,
    totalPages,
    currentPage: page,
    categories: Array.from(allCategories),
    videos: paginated,
  });
});

// ২. থাম্বনেইল API (HD & Fallback Handled)
app.get("/api/thumb/:messageId", async (req, res) => {
  try {
    const tg = await getConnectedClient();
    const messageId = parseInt(req.params.messageId);
    const [msg] = await tg.getMessages(CHANNEL_ID, { ids: [messageId] });

    if (!msg || !msg.media || !msg.media.document) {
      return res.status(404).send("Thumb not found");
    }

    const doc = msg.media.document;
    const thumbs = doc.thumbs || [];
    if (thumbs.length === 0) return res.status(404).send("No thumb");

    let selectedThumb = null;
    const preferredTypes = ["w", "y", "d", "x", "m"];
    for (const type of preferredTypes) {
      const match = thumbs.find(
        (t) => t.type === type || (t.className && t.className.toLowerCase().includes("photosize"))
      );
      if (match && match.className !== "PhotoStrippedSize") {
        selectedThumb = match;
        break;
      }
    }

    if (!selectedThumb) {
      const nonStripped = thumbs.filter((t) => t.className !== "PhotoStrippedSize");
      selectedThumb = nonStripped.length > 0 ? nonStripped[nonStripped.length - 1] : thumbs[thumbs.length - 1];
    }

    const buffer = await tg.downloadMedia(msg.media, { thumb: selectedThumb });
    if (!buffer) return res.status(404).send("Failed");

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(buffer);
  } catch (e) {
    res.status(404).send("Thumb error");
  }
});

// ৩. স্ট্রিমিং API
app.get("/api/stream/:messageId", async (req, res) => {
  try {
    const tg = await getConnectedClient();
    const messageId = parseInt(req.params.messageId);
    const [message] = await tg.getMessages(CHANNEL_ID, { ids: [messageId] });

    if (!message || !message.media || !message.media.document) {
      return res.status(404).send("File not found");
    }

    const doc = message.media.document;
    const fileSize = Number(doc.size);
    const mimeType = doc.mimeType || "video/mp4";
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (end >= fileSize) end = fileSize - 1;

      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mimeType,
      });

      const iter = tg.iterDownload({
        file: message.media,
        offset: bigInt(start),
        limit: chunkSize,
        requestSize: 1024 * 1024,
      });

      for await (const chunk of iter) {
        if (res.writableEnded || res.destroyed) break;
        res.write(chunk);
      }
      res.end();
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
      });

      const iter = tg.iterDownload({
        file: message.media,
        requestSize: 1024 * 1024,
      });

      for await (const chunk of iter) {
        if (res.writableEnded || res.destroyed) break;
        res.write(chunk);
      }
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).send("Streaming error");
  }
});

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});
