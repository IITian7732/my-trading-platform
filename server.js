const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Connect to Database
const dbPath = process.env.DATABASE_URL || './trading_v2.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database connection failed:", err.message);
    else console.log("💾 Connected to the production SQLite database.");
});

// Initialize Tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS account (user_id INTEGER PRIMARY KEY, available_cash REAL NOT NULL, blocked_margin REAL NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    db.run(`CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, symbol TEXT, side TEXT, qty REAL, entry_price REAL, product TEXT, margin_allocated REAL, stop_loss REAL, take_profit REAL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    db.run(`CREATE TABLE IF NOT EXISTS trade_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, symbol TEXT, side TEXT, qty REAL, entry_price REAL, close_price REAL, pnl REAL, closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
});

// Core APIs
app.post('/api/signup', (req, res) => {
    const { username, password, startingCapital } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.status(400).json({ error: "Username already exists!" });
        const newUserId = this.lastID;
        db.run(`INSERT INTO account (user_id, available_cash, blocked_margin) VALUES (?, ?, 0.00)`, [newUserId, parseFloat(startingCapital)], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Registration successful!", userId: newUserId, username: username });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: "Invalid credentials" });
        res.json({ message: "Login successful!", userId: user.id, username: user.username });
    });
});

app.get('/api/account', (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    db.get(`SELECT available_cash, blocked_margin FROM account WHERE user_id = ?`, [userId], (err, accountRow) => {
        if (err || !accountRow) return res.status(404).json({ error: "Account parameters missing" });
        db.all(`SELECT * FROM positions WHERE user_id = ?`, [userId], (err, positionRows) => {
            db.all(`SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC`, [userId], (err, historyRows) => {
                res.json({
                    availableCash: accountRow.available_cash, blockedMargin: accountRow.blocked_margin,
                    openPositions: positionRows.map(pos => ({ id: pos.id, symbol: pos.symbol, side: pos.side, qty: pos.qty, entryPrice: pos.entry_price, product: pos.product, marginAllocated: pos.margin_allocated, stopLoss: pos.stop_loss, takeProfit: pos.take_profit })),
                    tradeHistory: historyRows
                });
            });
        });
    });
});

app.post('/api/trade', (req, res) => {
    const userId = req.headers['user-id'];
    const { symbol, side, qty, price, product, stopLoss, takeProfit } = req.body;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const leverage = (product === 'MIS') ? 5 : 1;
    const requiredMargin = (price * qty) / leverage;

    db.get(`SELECT available_cash, blocked_margin FROM account WHERE user_id = ?`, [userId], (err, row) => {
        if (err || !row) return res.status(500).json({ error: "Account balance error" });
        if (requiredMargin > row.available_cash) return res.status(400).json({ error: "Order Rejected: Insufficient Margin" });

        const newAvailable = row.available_cash - requiredMargin;
        const newBlocked = row.blocked_margin + requiredMargin;

        db.serialize(() => {
            db.run(`UPDATE account SET available_cash = ?, blocked_margin = ? WHERE user_id = ?`, [newAvailable, newBlocked, userId]);
            db.run(`INSERT INTO positions (user_id, symbol, side, qty, entry_price, product, margin_allocated, stop_loss, take_profit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [userId, symbol, side, qty, price, product, requiredMargin, stopLoss ? parseFloat(stopLoss) : null, takeProfit ? parseFloat(takeProfit) : null], function(err) {
                    db.all(`SELECT * FROM positions WHERE user_id = ?`, [userId], (err, positionRows) => {
                        db.all(`SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC`, [userId], (err, historyRows) => {
                            res.json({ account: { availableCash: newAvailable, blockedMargin: newBlocked, openPositions: positionRows.map(p => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entry_price, product: p.product, marginAllocated: p.margin_allocated, stopLoss: p.stop_loss, takeProfit: p.take_profit })), tradeHistory: historyRows } });
                        });
                    });
                });
        });
    });
});

app.post('/api/close', (req, res) => {
    const userId = req.headers['user-id'];
    const { positionId, currentPrice } = req.body;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    db.get(`SELECT * FROM positions WHERE id = ? AND user_id = ?`, [positionId, userId], (err, pos) => {
        if (err || !pos) return res.status(404).json({ error: "Position trace missing" });
        const pnl = pos.side === 'BUY' ? (currentPrice - pos.entry_price) * pos.qty : (pos.entry_price - currentPrice) * pos.qty;

        db.get(`SELECT available_cash, blocked_margin FROM account WHERE user_id = ?`, [userId], (err, acc) => {
            const newAvailable = acc.available_cash + pos.margin_allocated + pnl;
            const newBlocked = acc.blocked_margin - pos.margin_allocated;

            db.serialize(() => {
                db.run(`UPDATE account SET available_cash = ?, blocked_margin = ? WHERE user_id = ?`, [newAvailable, newBlocked, userId]);
                db.run(`INSERT INTO trade_history (user_id, symbol, side, qty, entry_price, close_price, pnl) VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, pos.symbol, pos.side, pos.qty, pos.entry_price, currentPrice, pnl], () => {
                    db.run(`DELETE FROM positions WHERE id = ? AND user_id = ?`, [positionId, userId], () => {
                        db.all(`SELECT * FROM positions WHERE user_id = ?`, [userId], (err, positionRows) => {
                            db.all(`SELECT * FROM trade_history WHERE user_id = ? ORDER BY closed_at DESC`, [userId], (err, historyRows) => {
                                res.json({ account: { availableCash: newAvailable, blockedMargin: newBlocked, openPositions: positionRows.map(p => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entry_price, product: p.product, marginAllocated: p.margin_allocated, stopLoss: p.stop_loss, takeProfit: p.take_profit })), tradeHistory: historyRows } });
                            });
                        });
                    });
                });
            });
        });
    });
});

// USE THIS NEW BLOCK INSTEAD
app.get('/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Production Engine Server running on port ${PORT}`);
});