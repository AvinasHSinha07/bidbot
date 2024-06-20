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

async function checkAndFinalizeAuction(item) {
  const now = new Date();

  if (item.endTime <= now && !item.completed) {
    const highestBid = item.highestBid;

    if (highestBid) {
      const winner = await usersCollection().findOne({ userId: highestBid.userId });
      if (winner) {
        await bot.sendMessage(winner.userId, `Congratulations! You have won the auction for '${item.name}' with a bid of $${highestBid.amount}.`);
      }
    }

    const creator = await usersCollection().findOne({ userId: item.creatorId });
    if (creator) {
      await bot.sendMessage(creator.userId, `The auction for '${item.name}' has ended. The winning bid is $${highestBid ? highestBid.amount : 0}.`);
    }

    try {
      await itemsCollection().updateOne({ _id: item._id }, { $set: { completed: true } });
      await itemsCollection().deleteOne({ _id: item._id });
      console.log(`Item '${item.name}' has been deleted.`);
    } catch (err) {
      console.error(`Error marking item '${item.name}' as completed or deleting:`, err);
    }
  }
}

setInterval(async () => {
  try {
    const now = new Date();
    const items = await itemsCollection().find({ endTime: { $lte: now }, completed: { $ne: true } }).toArray();
    for (const item of items) {
      await checkAndFinalizeAuction(item);
    }
  } catch (err) {
    console.error('Error checking and finalizing auctions:', err);
  }
}, 60000);

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

bot.onText(/\/createitem (\w+) (\d+) (\d+) (\d+) (low|high)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const itemName = match[1];
  const lowAmount = parseFloat(match[2]);
  const highAmount = parseFloat(match[3]);
  const auctionDurationMinutes = parseInt(match[4]);
  const bidDirection = match[5]; 

  if (isNaN(lowAmount) || isNaN(highAmount) || isNaN(auctionDurationMinutes) || lowAmount <= 0 || highAmount <= 0 || lowAmount >= highAmount) {
    return bot.sendMessage(chatId, 'Please enter valid low and high bid amounts and a valid auction duration in minutes. Low amount should be less than high amount.');
  }

  const endTime = new Date(new Date().getTime() + auctionDurationMinutes * 60000);

  try {
    const registeredUser = await usersCollection().findOne({ userId });
    if (!registeredUser) {
      return bot.sendMessage(chatId, 'You need to register first using /register command.');
    }

    const item = { name: itemName, creatorId: userId, lowAmount, highAmount, endTime, highestBid: null, completed: false, bidDirection };
    await itemsCollection().insertOne(item);

    bot.sendMessage(chatId, `Item '${itemName}' has been created for bidding with bid range $${lowAmount} - $${highAmount} and bid direction: ${bidDirection}. Auction ends at ${endTime.toLocaleString()}.`);
  } catch (err) {
    console.error("Error creating item:", err);
    bot.sendMessage(chatId, 'Failed to create item. Please try again later.');
  }
});

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const userId = callbackQuery.from.id;
  const data = JSON.parse(callbackQuery.data);
  
  if (data.action === 'bid') {
    const itemName = data.item;
    const bidDirection = data.direction;

    try {
      const item = await itemsCollection().findOne({ name: itemName });
      if (!item) {
        return bot.sendMessage(msg.chat.id, `Item '${itemName}' does not exist.`);
      }

      if (item.bidDirection !== bidDirection) {
        return bot.sendMessage(msg.chat.id, `This item only accepts bids towards ${item.bidDirection} amounts.`);
      }

      bot.sendMessage(msg.chat.id, `You can now bid on '${itemName}' with direction: ${bidDirection}.`);
    } catch (err) {
      console.error("Error handling bid direction:", err);
      bot.sendMessage(msg.chat.id, 'Error handling bid direction. Please try again later.');
    }
  }
});

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

    const now = new Date();
    if (item.endTime <= now) {
      return bot.sendMessage(chatId, `The auction for '${itemName}' has already ended.`);
    }

    if (item.bidDirection === 'low' && bidAmount >= item.highAmount) {
      return bot.sendMessage(chatId, `This item accepts bids towards low amounts only. Your bid should be less than $${item.highAmount}.`);
    } else if (item.bidDirection === 'high' && bidAmount <= item.lowAmount) {
      return bot.sendMessage(chatId, `This item accepts bids towards high amounts only. Your bid should be more than $${item.lowAmount}.`);
    }

    const session = client.startSession();
    try {
      session.startTransaction();

      const itemWithLock = await itemsCollection().findOne({ _id: item._id }, { session });

      if (itemWithLock.highestBid && bidAmount <= itemWithLock.highestBid.amount) {
        await session.abortTransaction();
        return bot.sendMessage(chatId, `Your bid must be higher than the current highest bid of $${itemWithLock.highestBid.amount}.`);
      }

      const bid = { itemId: itemWithLock._id, userId, amount: bidAmount, timestamp: new Date() };
      await bidsCollection().insertOne(bid, { session });
      await itemsCollection().updateOne({ _id: itemWithLock._id }, { $set: { highestBid: bid } }, { session });

      if (itemWithLock.highestBid) {
        const previousBidder = await usersCollection().findOne({ userId: itemWithLock.highestBid.userId });
        if (previousBidder) {
          bot.sendMessage(previousBidder.userId, `You have been outbid on '${itemName}'. The new highest bid is $${bidAmount}.`);
        }
      }

      await session.commitTransaction();
      bot.sendMessage(chatId, `Your bid of $${bidAmount} on '${itemName}' has been placed.`);
    } catch (err) {
      await session.abortTransaction();
      console.error("Error placing bid:", err);
      bot.sendMessage(chatId, 'Error placing your bid. Please try again later.');
    } finally {
      session.endSession();
    }
  } catch (err) {
    console.error("Error placing bid:", err);
    bot.sendMessage(chatId, 'Error placing your bid. Please try again later.');
  }
});

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

bot.onText(/\/items/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const items = await itemsCollection().find().toArray();
    if (items.length === 0) {
      return bot.sendMessage(chatId, 'No items available for bidding.');
    }

    const itemList = items.map(item => {
      const highestBid = item.highestBid ? `$${item.highestBid.amount}` : 'No bids yet';
      const timestamp = item.highestBid && item.highestBid.timestamp ? item.highestBid.timestamp.toLocaleString() : 'N/A';
      return `${item.name} - Highest Bid: ${highestBid}, Bid Time: ${timestamp}`;
    }).join('\n');
    
    bot.sendMessage(chatId, `Items available for bidding:\n${itemList}`);
  } catch (err) {
    console.error("Error listing items:", err);
    bot.sendMessage(chatId, 'Error listing items. Please try again later.');
  }
});

bot.onText(/\/biddeditems/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const items = await itemsCollection().find({ highestBid: { $exists: true } }).toArray();
    if (items.length === 0) {
      return bot.sendMessage(chatId, 'No items have received bids yet.');
    }

    const itemList = items.map(item => {
      const highestBid = item.highestBid ? `$${item.highestBid.amount}` : 'No bids yet';
      const timestamp = item.highestBid && item.highestBid.timestamp ? item.highestBid.timestamp.toLocaleString() : 'N/A';
      return `${item.name} - Highest Bid: ${highestBid}, Bid Time: ${timestamp}`;
    }).join('\n');
    
    bot.sendMessage(chatId, `Bidded items:\n${itemList}`);
  } catch (err) {
    console.error("Error listing bidded items:", err);
    bot.sendMessage(chatId, 'Error listing bidded items. Please try again later.');
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `Commands:
  /register - Register to participate in bidding
  /createitem <item_name> <low_amount> <high_amount> <auction_duration_minutes> (low|high) - Create a new item for bidding with a bid range, auction duration, and bid direction
  /bid <item_name> <amount> - Place a bid on an item within the specified bid range and according to the bid direction chosen by the seller
  /currentbid <item_name> - View the current highest bid on an item
  /items - List all items available for bidding
  /biddeditems - List items that have received bids
  /help - Display this help message`;
  bot.sendMessage(chatId, helpMessage);
});

app.get('/', (req, res) => {
  res.send('Bot is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});

bot.on('polling_error', (err) => {
  console.error(err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

console.log('Telegram bot is running...');
