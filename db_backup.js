const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const BACKUP_DIR = process.env.DB_BACKUP_DIR || "/var/backups/db";
const RSYNC_TARGETS = process.env.RSYNC_TARGETS ? process.env.RSYNC_TARGETS.split(",") : [];
const NODE_IP = process.env.NODE_IP || "localhost";

const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "virtualizor";
const MYSQLDUMP_BIN = process.env.MYSQLDUMP_BIN || "mysqldump";
const MYSQL_SOCKET = process.env.MYSQL_SOCKET;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;

// ======================
// Log helpers
// ======================
const LOG_FILE = path.join(BACKUP_DIR, "backup.log");
const ERR_FILE = path.join(BACKUP_DIR, "backup-error.log");

function log(message, isError = false) {
    const utcTime = new Date().toISOString();
    const localTime = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const line = `[UTC ${utcTime} | Local ${localTime}] ${message}\n`;
    fs.appendFileSync(isError ? ERR_FILE : LOG_FILE, line);
    console[isError ? "error" : "log"](line.trim());
}

// ======================
// Telegram
// ======================
function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: `[${NODE_IP}] ${message}`
    }).catch(err => log(`Telegram send error: ${err.message}`, true));
}

// ======================
// Push metric
// ======================
function pushMetric(status) {
    if (!PUSHGATEWAY_URL) return;
    try {
        const pushUrl = `${PUSHGATEWAY_URL}/metrics/job/db_backup/instance/${NODE_IP}`;
        const metric = `db_backup{db="${DB_NAME}", node="${NODE_IP}"} ${status}\n`;
        execSync(`echo '${metric}' | curl --data-binary @- ${pushUrl}`);
        log(`Push metric: ${status}`);
    } catch (e) {
        log(`Push metric lỗi DB: ${e.message}`, true);
    }
}

// ======================
// Backup DB
// ======================
function backupDB() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dumpFile = path.join(BACKUP_DIR, `db_${DB_NAME}_${timestamp}.sql.gz`);
        execSync(`mkdir -p ${BACKUP_DIR}`);
        execSync(`${MYSQLDUMP_BIN} --socket=${MYSQL_SOCKET || ""} -u${DB_USER} -p${DB_PASS} ${DB_NAME} | gzip > ${dumpFile}`);
        log(`Backup DB ${DB_NAME} OK: ${dumpFile}`);
        sendTelegram(`Backup DB ${DB_NAME} OK`);
        pushMetric(1);

        // Cleanup old DB backups (giữ lại 1 file mới nhất)
        execSync(`ls -1t ${BACKUP_DIR}/db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f`);
        log(`Cleanup old DB backups done`);

        return dumpFile;
    } catch (e) {
        log(`Backup DB ${DB_NAME} FAILED: ${e.message}`, true);
        sendTelegram(`Backup DB ${DB_NAME} FAILED: ${e.message}`);
        pushMetric(0);
        return null;
    }
}

// ======================
// Backup Config Virtualizor
// ======================
function backupConfig() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const confFile = path.join(BACKUP_DIR, `conf_virtualizor_${timestamp}.tar.gz`);
        execSync(`tar -czf ${confFile} /var/virtualizor/log /usr/local/virtualizor/universal.php /usr/local/virtualizor/conf`, { stdio: "ignore" });
        log(`Backup config Virtualizor OK: ${confFile}`);
        sendTelegram(`Backup config Virtualizor OK`);

        // Cleanup old config backups (giữ lại 1 file mới nhất)
        execSync(`ls -1t ${BACKUP_DIR}/conf_virtualizor_*.tar.gz | tail -n +2 | xargs -r rm -f`);
        log(`Cleanup old config backups done`);

        return confFile;
    } catch (e) {
        log(`Backup config Virtualizor FAILED: ${e.message}`, true);
        sendTelegram(`Backup config Virtualizor FAILED: ${e.message}`);
        return null;
    }
}

// ======================
// Rsync backups
// ======================
function syncBackup(files) {
    if (!files || files.length === 0) return;
    RSYNC_TARGETS.forEach(target => {
        if (!target) return;
        try {
            execSync(`rsync -avz ${files.join(" ")} ${LOG_FILE} ${ERR_FILE} root@${target}:${BACKUP_DIR}/`);
            log(`Rsync backups + logs to ${target} done`);
            sendTelegram(`Rsync backups + logs to ${target} done`);

            execSync(`ssh root@${target} "
                cd ${BACKUP_DIR} &&
                ls -1t db_${DB_NAME}_*.sql.gz | tail -n +2 | xargs -r rm -f &&
                ls -1t conf_virtualizor_*.tar.gz | tail -n +2 | xargs -r rm -f &&
                ls -1t backup.log | tail -n +2 | xargs -r rm -f &&
                ls -1t backup-error.log | tail -n +2 | xargs -r rm -f
            "`);
            log(`Cleanup old backups + logs on ${target} done`);
        } catch (e) {
            log(`Rsync/cleanup backups + logs to ${target} FAILED: ${e.message}`, true);
            sendTelegram(`Rsync/cleanup backups + logs to ${target} FAILED: ${e.message}`);
        }
    });
}

// ======================
// Main job
// ======================
function job() {
    log("Starting Virtualizor backup (DB + Config + Logs)...");
    sendTelegram("Starting Virtualizor backup (DB + Config + Logs)...");
    const dbFile = backupDB();
    const confFile = backupConfig();
    syncBackup([dbFile, confFile].filter(Boolean));
    log("Backup job finished.");
}

// Chạy ngay khi start
job();

// Lặp lại mỗi 1 giờ
setInterval(job, 60 * 60 * 1000);
