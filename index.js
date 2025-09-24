import express from "express";
import fs from "fs";
import schedule from "node-schedule";
import makeWASocket, {
  useSingleFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@adiwajshing/baileys";
import { Boom } from "@hapi/boom";
import { Sticker } from "wa-sticker-formatter";

const app = express();
const PORT = process.env.PORT || 3000;
const kuliahFile = "./kuliah.json";
const sessionFile = "./session.json";

// === Jadwal & Tugas ===
function loadKuliah() {
  if (!fs.existsSync(kuliahFile)) {
    fs.writeFileSync(kuliahFile, JSON.stringify({ jadwal: {}, tugas: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(kuliahFile));
}
function saveKuliah(data) {
  fs.writeFileSync(kuliahFile, JSON.stringify(data, null, 2));
}

// === Bot WA ===
async function startBot() {
  const { state, saveState } = useSingleFileAuthState(sessionFile);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false // jangan print QR
  });

  sock.ev.on("creds.update", saveState);

  // === Pairing code login kalau belum ada session ===
  if (!state.creds.registered) {
    const phoneNumber = process.env.WA_NUMBER || "62xxxxxxxxxx"; // set di Render Env
    console.log("📱 Pairing dengan nomor:", phoneNumber);
    const code = await sock.requestPairingCode(phoneNumber);
    console.log("🔑 Masukkan kode berikut di WhatsApp (Linked Devices):", code);
  }

  // === Pesan masuk ===
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      (msg.message.imageMessage && "[sticker_request]");

    // Auto reply
    if (text?.toLowerCase() === "ping") {
      await sock.sendMessage(from, { text: "pong ✅" });
    }

    // Sticker maker
    if (msg.message.imageMessage) {
      const buffer = await sock.downloadMediaMessage(msg);
      const sticker = new Sticker(buffer, {
        pack: "KuliahBot",
        author: "Baileys",
        type: "full"
      });
      await sock.sendMessage(from, await sticker.toMessage());
    }

    // Command kuliah
    if (text?.startsWith("/")) {
      const args = text.trim().split(" ");
      const cmd = args[0].toLowerCase();
      let data = loadKuliah();

      if (cmd === "/jadwal") {
        const hari = new Date()
          .toLocaleDateString("id-ID", { weekday: "long" })
          .toLowerCase();
        const jadwalHari = data.jadwal[hari] || [];
        if (jadwalHari.length === 0) {
          await sock.sendMessage(from, { text: `Tidak ada jadwal hari ${hari}` });
        } else {
          let reply = `📅 Jadwal ${hari}:\n`;
          jadwalHari.forEach((j, i) => {
            reply += `${i + 1}. ${j.matkul} (${j.jam}) - ${j.info}\n`;
          });
          await sock.sendMessage(from, { text: reply });
        }
      }

      if (cmd === "/tugas") {
        if (args[1] === "add") {
          const raw = text.substring(11, text.length - 1);
          const [judul, matkul, jam, id] = raw.split(",");
          data.tugas.push({ id, judul, matkul, jam });
          saveKuliah(data);
          await sock.sendMessage(from, { text: `✅ Tugas ditambahkan: ${judul}` });
        } else if (args[1] === "remove") {
          const id = args[2];
          data.tugas = data.tugas.filter((t) => t.id !== id);
          saveKuliah(data);
          await sock.sendMessage(from, { text: `🗑️ Tugas ${id} dihapus` });
        } else {
          if (data.tugas.length === 0) {
            await sock.sendMessage(from, { text: "📌 Tidak ada tugas" });
          } else {
            let reply = "📌 Daftar Tugas:\n";
            data.tugas.forEach((t) => {
              reply += `ID:${t.id} - ${t.judul} (${t.matkul}) [${t.jam}]\n`;
            });
            await sock.sendMessage(from, { text: reply });
          }
        }
      }
    }
  });

  // Reminder jam 05:00 WIB
  schedule.scheduleJob("0 5 * * *", async () => {
    const chats = Object.keys(sock.chats);
    for (let jid of chats) {
      await sock.sendMessage(jid, { text: "⏰ Selamat pagi! Jangan lupa kuliah hari ini." });
    }
  });

  // Reminder 5 menit sebelum jadwal
  schedule.scheduleJob("*/1 * * * *", async () => {
    const data = loadKuliah();
    const now = new Date();
    const hari = now
      .toLocaleDateString("id-ID", { weekday: "long" })
      .toLowerCase();
    const jadwalHari = data.jadwal[hari] || [];

    for (let j of jadwalHari) {
      const [h, m] = j.jam.split(":").map(Number);
      const jadwalDate = new Date(now);
      jadwalDate.setHours(h, m - 5, 0, 0);

      if (
        now.getHours() === jadwalDate.getHours() &&
        now.getMinutes() === jadwalDate.getMinutes()
      ) {
        const chats = Object.keys(sock.chats);
        for (let jid of chats) {
          await sock.sendMessage(jid, {
            text: `⚠️ 5 menit lagi ${j.matkul} (${j.jam})`
          });
        }
      }
    }
  });

  // Connection handler
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("connection closed. reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Bot terhubung ke WhatsApp");
    }
  });
}

startBot();

// === HTTP server biar Render tidak mati ===
app.get("/", (req, res) => {
  res.send("WhatsApp KuliahBot aktif 🚀");
});
app.listen(PORT, () => console.log("Server running on port " + PORT));
