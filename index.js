require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN);
const userStates = {};

const categories = ['Еда', 'Транспорт', 'Одежда', 'Развлечения', 'Другое'];

function mainMenu() {
  return Markup.keyboard([
    ['➕ Добавить трату'],
    ['📜 Посмотреть траты', '📊 Статистика'],
    ['📅 Фильтр по дате', '♻️ Сброс'],
    ['💾 Экспорт', '💰 Лимит'],
    ['🔄 Перезапуск']
  ]).resize();
}

bot.start((ctx) => {
  userStates[ctx.from.id] = {};
  ctx.reply('Привет! Что хочешь сделать?', mainMenu());
});

bot.hears('🔄 Перезапуск', (ctx) => {
  userStates[ctx.from.id] = {};
  ctx.reply('Бот перезапущен', mainMenu());
});

bot.hears('💰 Лимит', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_limit' };
  ctx.reply('Введи лимит на день в рублях (например: 500):');
});

bot.hears('➕ Добавить трату', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_category' };
  ctx.reply('Выбери категорию:', Markup.keyboard(categories).resize());
});

bot.hears('📊 Статистика', (ctx) => {
  const userId = ctx.from.id;
  db.getCategoryStats(userId, (rows) => {
    if (!rows.length) return ctx.reply('У тебя нет трат для статистики.');
    const stats = rows.map(r => `${r.category}: ${r.total}₽`).join('\n');
    ctx.reply(`📊 Твоя статистика по категориям:\n\n${stats}`);
  });
});

bot.hears('💾 Экспорт', (ctx) => {
  const userId = ctx.from.id;
  db.getExpenses(userId, (rows) => {
    if (!rows.length) return ctx.reply('У тебя пока нет трат для экспорта.');
    const content = rows.map(e => `${e.timestamp} - ${e.category}: ${e.amount}₽`).join('\n');
    require('fs').writeFileSync(`export_${userId}.txt`, content);
    ctx.replyWithDocument({ source: `export_${userId}.txt` });
  });
});

bot.hears('📅 Фильтр по дате', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_filter_choice' };
  ctx.reply('Выбери период:', Markup.keyboard([
    ['Сегодня', 'Неделя', 'Месяц'],
    ['⬅️ Назад']
  ]).resize());
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const state = userStates[userId] || {};

  if (state.stage === 'awaiting_limit') {
    const limit = parseFloat(text.replace(',', '.'));
    if (isNaN(limit)) {
      ctx.reply('Это не число. Введи лимит снова:');
    } else {
      db.setDailyLimit(userId, limit);
      userStates[userId] = {};
      ctx.reply(`Лимит установлен: ${limit}₽ в день`, mainMenu());
    }
    return;
  }

  if (state.stage === 'awaiting_filter_choice') {
    if (text === '⬅️ Назад') {
      userStates[userId] = {};
      return ctx.reply('Возвращаемся в меню.', mainMenu());
    }

    let period = '';
    if (text === 'Сегодня') period = 'day';
    else if (text === 'Неделя') period = 'week';
    else if (text === 'Месяц') period = 'month';
    else return ctx.reply('Неверный выбор. Пожалуйста, выбери из списка.');

    db.getFilteredExpenses(userId, period, (rows) => {
      if (!rows.length) return ctx.reply('Нет трат за выбранный период.');
      const list = rows.map((e, i) => `${i + 1}. ${e.timestamp.split('T')[0]} — ${e.category}: ${e.amount}₽`).join('\n');
      ctx.reply(`Твои траты за период «${text}»:\n\n${list}`, mainMenu());
    });
    userStates[userId] = {};
    return;
  }

  if (state.stage === 'awaiting_category' && categories.includes(text)) {
    state.category = text;
    state.stage = 'awaiting_amount';
    ctx.reply(`Введи сумму для категории "${text}":`);
  } else if (state.stage === 'awaiting_amount') {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount)) {
      ctx.reply('Это не похоже на число. Попробуй ещё раз.');
    } else {
      state.amount = amount;
      state.stage = 'awaiting_confirmation';
      ctx.reply(
        `Подтверди трату: ${state.category} — ${amount}₽`,
        Markup.keyboard(['✅ Подтвердить', '❌ Отмена']).resize()
      );
    }
  } else if (state.stage === 'awaiting_confirmation') {
    if (text === '✅ Подтвердить') {
      db.addExpense(userId, state.category, state.amount);
      userStates[userId] = {};

      db.getDailyLimit(userId, (limit) => {
        db.getTodayTotal(userId, (total) => {
          let message = 'Трата добавлена!';
          if (limit > 0 && total > limit) {
            message += ` ⚠️ Ты превысил дневной лимит: ${total}₽ / ${limit}₽`;
          }
          ctx.reply(message, mainMenu());
        });
      });
    } else if (text === '❌ Отмена') {
      userStates[userId] = {};
      ctx.reply('Добавление траты отменено.', mainMenu());
    }
  } else if (text === '📜 Посмотреть траты') {
    db.getExpenses(userId, (rows) => {
      if (!rows.length) return ctx.reply('У тебя пока нет трат.');
      const list = rows.map((e, i) => `${i + 1}. ${e.category} — ${e.amount}₽`).join('\n');
      ctx.reply(`Твои траты:\n\n${list}`);
    });
  } else if (text === '♻️ Сброс') {
    db.resetExpenses(userId);
    ctx.reply('Все траты удалены.');
  }
});

cron.schedule('0 12 * * *', () => {
  console.log('⏰ Проверка активности пользователей...');
  for (const userId in userStates) {
    db.getLastExpenseDate(userId, (last) => {
      if (!last) return;
      const lastDate = new Date(last);
      const now = new Date();
      const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
      if (diffDays >= 2) {
        bot.telegram.sendMessage(userId, '🔔 Напоминание: ты не вносил траты уже 2 дня!');
      }
    });
  }
});

bot.launch();