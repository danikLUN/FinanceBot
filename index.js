require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN);
const userStates = {};
const REQUIRED_CHANNEL = '@FEDYFEFU';

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

function backButton() {
  return Markup.keyboard([['🔙 Вернуться в меню']]).resize();
}

async function checkSubscription(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
    return ['member', 'creator', 'administrator'].includes(member.status);
  } catch (error) {
    console.error('Ошибка при проверке подписки:', error);
    return false;
  }
}

bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text && ctx.message.text !== '✅ Я подписался') {
    const subscribed = await checkSubscription(ctx);
    if (!subscribed) {
      return ctx.reply(
        'Для использования бота подпишись на наш канал и нажми кнопку ниже.',
        Markup.inlineKeyboard([
          [Markup.button.url('Перейти в канал', `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`)],
          [Markup.button.callback('✅ Я подписался', 'check_sub')] 
        ])
      );
    }
  }
  await next();
});

bot.action('check_sub', async (ctx) => {
  const subscribed = await checkSubscription(ctx);
  if (subscribed) {
    userStates[ctx.from.id] = {};
    await ctx.answerCbQuery();
    await ctx.reply('Спасибо за подписку! Вот меню:', mainMenu());
  } else {
    await ctx.answerCbQuery('Подписка не обнаружена. Попробуй снова.');
  }
});

bot.start((ctx) => {
  userStates[ctx.from.id] = {};
  ctx.reply('Привет! Что хочешь сделать?', mainMenu());
});

bot.hears('🔄 Перезапуск', (ctx) => {
  userStates[ctx.from.id] = {};
  ctx.reply('Бот перезапущен', mainMenu());
});

bot.hears('🔙 Вернуться в меню', (ctx) => {
  userStates[ctx.from.id] = {};
  ctx.reply('Главное меню:', mainMenu());
});

bot.hears('💰 Лимит', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_limit' };
  ctx.reply('Введи лимит на день в рублях (например: 500):', backButton());
});

bot.hears('➕ Добавить трату', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_category' };
  ctx.reply('Выбери категорию:', Markup.keyboard([...categories.map(c => [c]), ['🔙 Вернуться в меню']]).resize());
});

bot.hears('📊 Статистика', (ctx) => {
  const userId = ctx.from.id;
  db.getCategoryStats(userId, (rows) => {
    if (!rows.length) return ctx.reply('У тебя нет трат для статистики.', backButton());
    const stats = rows.map(r => `${r.category}: ${r.total}₽`).join('\n');
    ctx.reply(`📊 Твоя статистика по категориям:\n\n${stats}`, backButton());
  });
});

bot.hears('💾 Экспорт', (ctx) => {
  const userId = ctx.from.id;
  db.getExpenses(userId, (rows) => {
    if (!rows.length) return ctx.reply('У тебя пока нет трат для экспорта.', backButton());
    const content = rows.map(e => `${e.timestamp} - ${e.category}: ${e.amount}₽`).join('\n');
    require('fs').writeFileSync(`export_${userId}.txt`, content);
    ctx.replyWithDocument({ source: `export_${userId}.txt` });
  });
});

bot.hears('📅 Фильтр по дате', (ctx) => {
  userStates[ctx.from.id] = { stage: 'awaiting_filter_choice' };
  ctx.reply('Выбери период:', Markup.keyboard([
    ['Сегодня', 'Неделя', 'Месяц'],
    ['🔙 Вернуться в меню']
  ]).resize());
});

bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const state = userStates[userId] || {};

  if (text === '🔙 Вернуться в меню') {
    userStates[userId] = {};
    return ctx.reply('Главное меню:', mainMenu());
  }

  if (state.stage === 'awaiting_limit') {
    const limit = parseFloat(text.replace(',', '.'));
    if (isNaN(limit)) {
      ctx.reply('Это не число. Введи лимит снова:', backButton());
    } else {
      db.setDailyLimit(userId, limit);
      userStates[userId] = {};
      ctx.reply(`Лимит установлен: ${limit}₽ в день`, mainMenu());
    }
    return;
  }

  if (state.stage === 'awaiting_filter_choice') {
    let period = '';
    if (text === 'Сегодня') period = 'day';
    else if (text === 'Неделя') period = 'week';
    else if (text === 'Месяц') period = 'month';
    else return ctx.reply('Неверный выбор. Пожалуйста, выбери из списка.', backButton());

    db.getFilteredExpenses(userId, period, (rows) => {
      if (!rows.length) return ctx.reply('Нет трат за выбранный период.', backButton());
      const list = rows.map((e, i) => `${i + 1}. ${e.timestamp.split('T')[0]} — ${e.category}: ${e.amount}₽`).join('\n');
      ctx.reply(`Твои траты за период «${text}»:\n\n${list}`, backButton());
    });
    userStates[userId] = {};
    return;
  }

  if (state.stage === 'awaiting_category' && categories.includes(text)) {
    state.category = text;
    state.stage = 'awaiting_amount';
    ctx.reply(`Введи сумму для категории "${text}":`, backButton());
  } else if (state.stage === 'awaiting_amount') {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount)) {
      ctx.reply('Это не похоже на число. Попробуй ещё раз.', backButton());
    } else {
      state.amount = amount;
      state.stage = 'awaiting_confirmation';
      ctx.reply(
        `Подтверди трату: ${state.category} — ${amount}₽`,
        Markup.keyboard(['✅ Подтвердить', '❌ Отмена', '🔙 Вернуться в меню']).resize()
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
      if (!rows.length) return ctx.reply('У тебя пока нет трат.', backButton());
      const list = rows.map((e, i) => `${i + 1}. ${e.category} — ${e.amount}₽`).join('\n');
      ctx.reply(`Твои траты:\n\n${list}`, backButton());
    });
  } else if (text === '♻️ Сброс') {
    db.resetExpenses(userId);
    ctx.reply('Все траты удалены.', mainMenu());
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