const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('expenses.db');
const fs = require('fs');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      category TEXT,
      amount REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      daily_limit REAL DEFAULT 0
    )
  `);
});

function addExpense(userId, category, amount) {
  db.run('INSERT INTO expenses (user_id, category, amount) VALUES (?, ?, ?)', [userId, category, amount]);
}

function getExpenses(userId, callback) {
  db.all('SELECT * FROM expenses WHERE user_id = ?', [userId], (err, rows) => {
    callback(rows);
  });
}

function resetExpenses(userId) {
  db.run('DELETE FROM expenses WHERE user_id = ?', [userId]);
}

function setDailyLimit(userId, limit) {
  db.run(
    'INSERT INTO settings (user_id, daily_limit) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET daily_limit = ?',
    [userId, limit, limit]
  );
}

function getDailyLimit(userId, callback) {
  db.get('SELECT daily_limit FROM settings WHERE user_id = ?', [userId], (err, row) => {
    callback(row ? row.daily_limit : 0);
  });
}

function getTodayTotal(userId, callback) {
  db.get(
    `SELECT SUM(amount) as total FROM expenses 
     WHERE user_id = ? AND date(timestamp) = date('now')`,
    [userId],
    (err, row) => {
      callback(row?.total || 0);
    }
  );
}

function getLastExpenseDate(userId, callback) {
  db.get(
    `SELECT timestamp FROM expenses WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [userId],
    (err, row) => {
      callback(row?.timestamp || null);
    }
  );
}

function getCategoryStats(userId, callback) {
  db.all(
    `SELECT category, SUM(amount) as total FROM expenses WHERE user_id = ? GROUP BY category`,
    [userId],
    (err, rows) => {
      callback(rows);
    }
  );
}

function getFilteredExpenses(userId, period, callback) {
  let condition = '';
  if (period === 'day') {
    condition = `date(timestamp) = date('now')`;
  } else if (period === 'week') {
    condition = `timestamp >= datetime('now', '-7 days')`;
  } else if (period === 'month') {
    condition = `timestamp >= datetime('now', '-30 days')`;
  }

  db.all(
    `SELECT * FROM expenses WHERE user_id = ? AND ${condition} ORDER BY timestamp DESC`,
    [userId],
    (err, rows) => {
      callback(rows);
    }
  );
}

module.exports = {
  addExpense,
  getExpenses,
  resetExpenses,
  setDailyLimit,
  getDailyLimit,
  getTodayTotal,
  getLastExpenseDate,
  getCategoryStats,
  getFilteredExpenses
};