require("dotenv").config();
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const session = new StringSession(process.env.SESSION_STRING);
const CHANNEL_ID = BigInt(process.env.CHANNEL_ID);

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

function parseCaption(text, fallbackFileName, msgId) {
  if (!text) {
    return {
      title: fallbackFileName || `Video #${msgId}`,
      categories: ["#uncategorized"],
    };
  }

  // 1. Title ber kora (Title 🎬:)
  let mainTitle = "";
  const titleMatch = text.match(/Title\s*🎬?\s*:\s*([^\n\r]+)/i);
  if (titleMatch && titleMatch[1]) {
    mainTitle = titleMatch[1].trim();
  }

  // 2. Series Info ber kora (Series Info, Series Info# ba emoji shoho)
  let seriesInfo = "";
  const seriesMatch = text.match(/Series\s*Info[^\w\n\r:]*[:#]\s*([^\n\r]+)/i);
  if (seriesMatch && seriesMatch[1]) {
    seriesInfo = seriesMatch[1].trim();
  }

  // 3. Final Combined Title: "Title - Series Info"
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

  // 4. Hashtag Categories
  const tagMatches = text.match(/#[a-zA-Z0-9_]+/g);
  let categories = [];
  if (tagMatches) {
    categories = tagMatches.map((t) => t.toLowerCase());
  } else {
    categories = ["#others"];
  }

  return { title: finalTitle, categories };
}

(async () => {
  await client.connect();
  console.log("Connected to Telegram. Re-indexing all videos...");

  const allVideos = [];
  let offsetId = 0;
  let batchCount = 0;

  while (true) {
    const messages = await client.getMessages(CHANNEL_ID, {
      limit: 100,
      offsetId: offsetId,
    });

    if (!messages || messages.length === 0) break;

    for (const msg of messages) {
      if (msg.media && msg.media.document) {
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

          allVideos.push({
            id: msg.id,
            title: parsed.title,
            caption: msg.message || "",
            categories: parsed.categories,
            size: Number(doc.size),
            mimeType: mime,
            date: msg.date,
          });
        }
      }
    }

    offsetId = messages[messages.length - 1].id;
    batchCount += messages.length;
    process.stdout.write(`\rScanned ${batchCount} messages... Found ${allVideos.length} videos.`);

    if (messages.length < 100) break;
  }

  fs.writeFileSync("videos.json", JSON.stringify(allVideos, null, 2));
  console.log(`\nDone! Successfully updated ${allVideos.length} videos into videos.json.`);
  process.exit(0);
})();