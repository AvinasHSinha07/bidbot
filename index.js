const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

let db;

client.connect()
  .then(() => {
    console.log("Connected to MongoDB!");
    db = client.db();
  })
  .catch(err => console.error("MongoDB connection error:", err));

const app = express();

const usersCollection = () => db.collection("users");
const itemsCollection = () => db.collection("items");
const bidsCollection = () => db.collection("bids");

// Register command
bot.onText(/\/register/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const existingUser = await usersCollection().findOne({ userId });
    if (existingUser) {
      return bot.sendMessage(chatId, 'You are already registered.');
    }
    await usersCollection().insertOne({ userId, chatId });
    bot.sendMessage(chatId, 'You have been successfully registered.');
  } catch (err) {
    console.error("Error registering user:", err);
    bot.sendMessage(chatId, 'Failed to register. Please try again later.');
  }
});

// Create item command
bot.onText(/\/createitem (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const itemName = match[1];

  try {
    const registeredUser = await usersCollection().findOne({ userId });
    if (!registeredUser) {
      return bot.sendMessage(chatId, 'You need to register first using /register command.');
    }

    const item = { name: itemName, creatorId: userId, highestBid: null };
    await itemsCollection().insertOne(item);
    bot.sendMessage(chatId, `Item '${itemName}' has been created for bidding.`);
  } catch (err) {
    console.error("Error creating item:", err);
    bot.sendMessage(chatId, 'Failed to create item. Please try again later.');
  }
});

// Bid command
bot.onText(/\/bid (\w+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const itemName = match[1];
  const bidAmount = parseFloat(match[2]);

  try {
    if (isNaN(bidAmount) || bidAmount <= 0) {
      return bot.sendMessage(chatId, 'Please enter a valid bid amount.');
    }

    const item = await itemsCollection().findOne({ name: itemName });
    if (!item) {
      return bot.sendMessage(chatId, `Item '${itemName}' does not exist.`);
    }

    if (item.highestBid && bidAmount <= item.highestBid.amount) {
      return bot.sendMessage(chatId, `Your bid must be higher than the current highest bid of $${item.highestBid.amount}.`);
    }

    const bid = { itemId: item._id, userId, amount: bidAmount, timestamp: new Date() };
    await bidsCollection().insertOne(bid);
    await itemsCollection().updateOne({ _id: item._id }, { $set: { highestBid: bid } });
    bot.sendMessage(chatId, `Your bid of $${bidAmount} on '${itemName}' has been placed.`);
  } catch (err) {
    console.error("Error placing bid:", err);
    bot.sendMessage(chatId, 'Error placing your bid. Please try again later.');
  }
});

// Current bid command
bot.onText(/\/currentbid (\w+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const itemName = match[1];

  try {
    const item = await itemsCollection().findOne({ name: itemName });
    if (!item) {
      return bot.sendMessage(chatId, `Item '${itemName}' does not exist.`);
    }

    if (!item.highestBid) {
      return bot.sendMessage(chatId, `No bids have been placed on '${itemName}' yet.`);
    }

    bot.sendMessage(chatId, `The current highest bid on '${itemName}' is $${item.highestBid.amount}.`);
  } catch (err) {
    console.error("Error fetching current highest bid:", err);
    bot.sendMessage(chatId, 'Error fetching the current highest bid. Please try again later.');
  }
});

// List items command
bot.onText(/\/items/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const items = await itemsCollection().find().toArray();
    if (items.length === 0) {
      return bot.sendMessage(chatId, 'No items available for bidding.');
    }

    const itemList = items.map(item => {
      const highestBid = item.highestBid ? `$${item.highestBid.amount}` : 'No bids yet';
      return `${item.name} - Highest Bid: ${highestBid}`;
    }).join('\n');

    bot.sendMessage(chatId, `Items available for bidding:\n${itemList}`);
  } catch (err) {
    console.error("Error listing items:", err);
    bot.sendMessage(chatId, 'Error listing items. Please try again later.');
  }
});

// Help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `Commands:
  /register - Register to participate in bidding
  /createitem <item_name> - Create a new item for bidding
  /bid <item_name> <amount> - Place a bid on an item
  /currentbid <item_name> - View the current highest bid on an item
  /items - List all items available for bidding
  /help - Display this help message`;
  bot.sendMessage(chatId, helpMessage);
});

// HTTP endpoint to keep bot alive (required for platforms like Vercel)
// Express endpoint to handle incoming updates from Telegram
app.use(express.json());

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Start the Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});

// Error handling
bot.on('polling_error', (err) => {
  console.error(err);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

console.log('Telegram bot is running...');
