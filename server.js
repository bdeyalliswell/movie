require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const bigInt = require("big-integer");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const app = express();
const port = process.env.PORT || 3000;

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const session = new StringSession(process.env.SESSION_STRING);
const CHANNEL_ID = BigInt(process.env.CHANNEL_ID);

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
  useWSS: false,
  autoReconnect: true,
});

// ক্যাপশন পার্স করার হেল্পার ফাংশন
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

// লোকাল ডাটাবেজ পড়া ও লেখা
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
  fs.writeFileSync("videos.json", JSON.stringify(data, null, 2));
}

(async () => {
  try {
    await client.connect();
    console.log("Telegram Client connected securely.");

    // AUTO-UPDATE LISTENER: চ্যানেলে নতুন ভিডিও এলে স্বয়ংক্রিয়ভাবে অ্যাড হবে
    client.addEventHandler(async (event) => {
      const msg = event.message;
      if (!msg || !msg.media || !msg.media.document) return;

      const doc = msg.media.document;
      const mime = doc.mimeType || "";
      const isVideo =
        mime.startsWith("video/") ||
        mime === "application/x-tgvideo" ||
        (doc.attributes && doc.attributes.some((a) => a.className === "DocumentAttributeVideo"));

      if (isVideo) {
        const fileAttr = doc.attributes.find((a) => a.fileName);
        const rawFileName = fileAttr ? fileAttr.fileName : "";
        const parsed = parseCaption(msg.message, rawFileName, msg.id);

        const newVideoItem = {
          id: msg.id,
          title: parsed.title,
          caption: msg.message || "",
          categories: parsed.categories,
          size: Number(doc.size),
          mimeType: mime,
          date: msg.date,
        };

        const currentVideos = getIndexedVideos();
        // ডুপ্লিকেট না থাকলে তালিকার শুরুতে যোগ করা হবে
        if (!currentVideos.some((v) => v.id === msg.id)) {
          currentVideos.unshift(newVideoItem);
          saveIndexedVideos(currentVideos);
          console.log(`[Auto-Update] New video added: ${parsed.title}`);
        }
      }
    }, new NewMessage({ chats: [CHANNEL_ID] }));

  } catch (err) {
    console.error("Telegram Connection Error:", err);
  }
})();

app.use(express.static(path.join(__dirname, "public")));

// ১. ভিডিও লিস্ট ও পেজিনেশন API
app.get("/api/videos", (req, res) => {
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

// ২. থাম্বনেইল API (HD)
app.get("/api/thumb/:messageId", async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const [msg] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });

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

    const buffer = await client.downloadMedia(msg.media, { thumb: selectedThumb });
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
    const messageId = parseInt(req.params.messageId);
    const [message] = await client.getMessages(CHANNEL_ID, { ids: [messageId] });

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

      const iter = client.iterDownload({
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

      const iter = client.iterDownload({
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