const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
require("dotenv").config();

const apiId = parseInt(process.env.API_ID || "30900613", 10);
const apiHash = process.env.API_HASH || "88795a0e0acb49288dca0dd4c8428456";
const stringSession = new StringSession("");

(async () => {
  console.log("=== Telegram Login Wizard ===");
  console.log("Connecting to Telegram MTProto...");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Enter Phone Number (e.g. +919748988376): "),
    password: async () => await input.text("Enter 2FA Password (if enabled, else press Enter): "),
    phoneCode: async () => await input.text("Enter Telegram Login Code: "),
    onError: (err) => console.error("Login Error:", err),
  });

  const sessionString = client.session.save();
  console.log("\n================ [SUCCESS] ================");
  console.log("আপনার সেশন স্ট্রিং নিচে তৈরি হয়েছে। এটি কপি করে .env ফাইলে SESSION_STRING এর ঘরে পেস্ট করুন:\n");
  console.log(sessionString);
  console.log("\n===========================================");
  process.exit(0);
})();