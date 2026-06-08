require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const WebSocket = require('ws');
const app = express();
const { S3Client } = require('@aws-sdk/client-s3'); // <--- ДОБАВИЛИ
const multerS3 = require('multer-s3');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
// Настройки
app.use(express.json());
app.use(cors());
app.use('/uploads', express.static('uploads')); // Для доступа к загруженным файлам

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'sopl-backend',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const wsClients = new Set();
const chatRooms = new Map(); // trackId → Set<WebSocket>
const onlineUsers = new Map(); // userId → Set<WebSocket>  ← ADD THIS HERE
const typingUsers = new Map(); 
// chatRooms.get(trackId) → Set<WebSocket>

function broadcastToTrack(trackId, payload, exclude = null) {
  const room = chatRooms.get(trackId);
  if (!room) return;
  const str = JSON.stringify(payload);
  room.forEach((ws) => {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    }
  });
}
async function broadcastUserStatus(userId, isOnline) {
  try {
    // Находим все чаты, где участвует этот пользователь
    const chats = await DirectChat.find({ participants: userId });
    
    for (const chat of chats) {
      // Находим собеседника
      const otherUser = chat.participants.find(p => p.toString() !== userId);
      if (!otherUser) continue;
      
      // Отправляем статус всем подключениям собеседника
      const otherUserConnections = onlineUsers.get(otherUser.toString());
      if (otherUserConnections) {
        const statusPayload = {
          type: 'user_status',
          userId: userId,
          isOnline
        };
        
        // Если пользователь оффлайн, добавляем lastSeen
        if (!isOnline) {
          statusPayload.lastSeen = new Date().toISOString();
        }
        
        otherUserConnections.forEach(connection => {
          if (connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify(statusPayload));
          }
        });
      }
    }
    
    console.log(`[Status] User ${userId} is now ${isOnline ? 'online' : 'offline'}`);
  } catch (error) {
    console.error('[Status] Error broadcasting status:', error);
  }
}
function sendListenersUpdate(trackId) {
  const room = chatRooms.get(trackId);
  const count = room ? room.size : 0;
  broadcastToTrack(trackId, { type: 'listeners_update', data: { count } });
}
function broadcastToVenue(venueId, payload) {
  const str = JSON.stringify(payload);
  wsClients.forEach((client) => {
    if (client.venueId === venueId && client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  });
}
const sendToTelegram = async (message) => {
  // 🔥 Берем данные из .env
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  // Если в .env забыли добавить переменные, просто выходим, чтобы сервер не упал
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn('⚠️ Telegram уведомления не настроены: проверьте .env');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error) {
    // Логируем ошибку, но не роняем сервер
    console.error('Ошибка отправки в Telegram:', error.message);
  }
};
const fs = require('fs');

let storage;

if (process.env.AWS_BUCKET_NAME) {
  const s3 = new S3Client({
    region: process.env.AWS_REGION, // например 'eu-central-1'
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  storage = multerS3({
    s3: s3,
    bucket: process.env.AWS_BUCKET_NAME, // Имя твоего бакета
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      // Генерируем уникальное имя файла: папка/дата-имя
      const folder = file.fieldname === 'audio' ? 'music/' : 'covers/';
      cb(null, folder + Date.now().toString() + '-' + file.originalname);
    }
  });
} else {
  console.warn('⚠️ AWS_BUCKET_NAME не задан в .env. Используется локальное хранилище в папке /uploads.');
  
  // Создаем папку uploads, если её нет
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads', { recursive: true });
  }
  if (!fs.existsSync('uploads/music')) {
    fs.mkdirSync('uploads/music', { recursive: true });
  }
  if (!fs.existsSync('uploads/covers')) {
    fs.mkdirSync('uploads/covers', { recursive: true });
  }

  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      const folder = file.fieldname === 'audio' ? 'uploads/music' : 'uploads/covers';
      cb(null, folder);
    },
    filename: function (req, file, cb) {
      cb(null, Date.now().toString() + '-' + file.originalname);
    }
  });
}

const upload = multer({ storage: storage });

// Обертка для multer-middleware, чтобы автоматически добавлять поле .location при локальной загрузке
const wrapper = (fn) => {
  return (req, res, next) => {
    fn(req, res, (err) => {
      if (err) return next(err);
      
      const host = req.get('host');
      const protocol = req.protocol;
      const processFile = (file) => {
        if (file && !file.location && file.path) {
          // Заменяем обратные слэши для Windows на прямые
          file.location = `${protocol}://${host}/${file.path.replace(/\\/g, '/')}`;
        }
      };

      if (req.file) {
        processFile(req.file);
      }
      if (req.files) {
        if (Array.isArray(req.files)) {
          req.files.forEach(processFile);
        } else {
          Object.keys(req.files).forEach(key => {
            req.files[key].forEach(processFile);
          });
        }
      }
      next();
    });
  };
};

const originalSingle = upload.single;
upload.single = function(...args) {
  return wrapper(originalSingle.apply(upload, args));
};

const originalFields = upload.fields;
upload.fields = function(...args) {
  return wrapper(originalFields.apply(upload, args));
};

const originalArray = upload.array;
upload.array = function(...args) {
  return wrapper(originalArray.apply(upload, args));
};
// ============================================
// СХЕМЫ ДАННЫХ (MongoDB Models)
// ============================================

// 1. ПОЛЬЗОВАТЕЛЬ
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'artist', 'venue_admin', 'super_admin'], default: 'user' },
  avatar_url: String,
  bio: String,
  location: String,
  venue_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue' },
  
  // 👇👇👇 ДОБАВЬ ЭТИ ДВА МАССИВА 👇👇👇
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likedTracks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Track' }],
  stats: {
    followers: { type: Number, default: 0 },
    following: { type: Number, default: 0 },
    playlists: { type: Number, default: 0 },
    totalListeningTime: { type: Number, default: 0 }
  },
  topGenres: [{
    name: String,
    percentage: Number
  }],
  isVerified: { type: Boolean, default: false },
  artistInfo:{
  stageName: String,
  genre: [String],
  bio: String,
  donationEnabled: { type: Boolean, default: false },
  donationGoal: String,
  socialLinks: {
    instagram: String,
    youtube: String,
    spotify: String,
  }},
  createdAt: { type: Date, default: Date.now }
});

// Индексы для быстрого поиска
UserSchema.index({ email: 1 });
UserSchema.index({ role: 1, 'stats.followers': -1 });

const User = mongoose.model('User', UserSchema);

// 2. ТРЕК
const TrackSchema = new mongoose.Schema({
  title: { type: String, required: true },
  artist: { type: String, required: true },
  artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  album: String,
  cover: { type: String, required: true },
  duration: { type: Number, required: true }, // секунды
  genre: String,
  releaseDate: Date,
  isProtected: { type: Boolean, default: false },
  playCount: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  audioUrl: String,
  // НОВЫЕ ПОЛЯ ДЛЯ МОДЕРАЦИИ
  isApproved: { type: Boolean, default: false }, // Прошёл ли модерацию
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Кто загрузил
  createdAt: { type: Date, default: Date.now }
});

// Индексы для поиска и сортировки
TrackSchema.index({ isApproved: 1, likes: -1, playCount: -1 });
TrackSchema.index({ title: 'text', artist: 'text' });
TrackSchema.index({ artistId: 1 });
TrackSchema.index({ uploadedBy: 1, isApproved: 1 });

const Track = mongoose.model('Track', TrackSchema);

// 3. ЗАВЕДЕНИЕ
const VenueSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  address: {
    street: String,
    city: String,
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  qr_code: { type: String, required: true, unique: true },
  venue_id: { type: String, unique: true }, // 🔥 ДОБАВИЛИ НОВОЕ ПОЛЕ
  menu_url: String,
  photo_url: String,
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  hours: {
    open: String,
    close: String
  },
  admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  phone: String,
  currentlyPlayingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Track' },
  createdAt: { type: Date, default: Date.now }
});

const Venue = mongoose.model('Venue', VenueSchema);
const VenueReviewSchema = new mongoose.Schema({
  venue_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, maxlength: 500 },
  createdAt: { type: Date, default: Date.now }
});

// Индекс для проверки уникальности (один пользователь = один отзыв на заведение)
VenueReviewSchema.index({ venue_id: 1, user_id: 1 }, { unique: true });

const VenueReview = mongoose.model('VenueReview', VenueReviewSchema);
// 4. МУЗЫКАЛЬНАЯ ОЧЕРЕДЬ
const QueueSchema = new mongoose.Schema({
  venue_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue', required: true },
  track_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  table_number: String,
  comment: String,
  status: { type: String, enum: ['pending', 'playing', 'completed', 'rejected'], default: 'pending' },
  position: Number,
  estimatedTime: Number,
  created_at: { type: Date, default: Date.now },
  started_at: Date,
  completed_at: Date
});

// Индексы для быстрой загрузки очереди
QueueSchema.index({ venue_id: 1, status: 1, created_at: 1 });

const Queue = mongoose.model('Queue', QueueSchema);

// 5. АКТИВНОСТЬ В ЛЕНТЕ
const FeedActivitySchema = new mongoose.Schema({
  type: { 
    type: String, 
    enum: [
      'listening_now',
      'playlist_add',
      'new_album',
      'friends_visit',
      'ordered_track', 
      'liked_track',
      'new_track'
    ],
    required: true 
  },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  track_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Track' },
  venue_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Venue' },
  
  playlist_name: String,
  album_cover: String,
  album_title: String,
  friends_count: Number,
  friends_avatars: [String],
  
  isLive: { type: Boolean, default: false },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // 🔥 ЭТО ПОЛЕ ДОЛЖНО БЫТЬ
  comments: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

// Индексы для ленты
FeedActivitySchema.index({ timestamp: -1 });
FeedActivitySchema.index({ user_id: 1, timestamp: -1 });
FeedActivitySchema.index({ type: 1, timestamp: -1 });

const FeedActivity = mongoose.model('FeedActivity', FeedActivitySchema);

// 6. ПЛЕЙЛИСТ
const PlaylistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  cover: String,
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tracks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Track' }],
  isPublic: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Playlist = mongoose.model('Playlist', PlaylistSchema);
const ArtistApplicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stageName: { type: String, required: true },
  genre: [String],
  bio: String,
  socialLinks: {
    instagram: String,
    youtube: String,
    spotify: String,
  },
  sampleTracks: [String], // Ссылки на примеры работ
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  rejectionReason: String,
  createdAt: { type: Date, default: Date.now }
});

const ArtistApplication = mongoose.model('ArtistApplication', ArtistApplicationSchema);
// ============================================
// MIDDLEWARE
// ============================================

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Не авторизован' });
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key_change_this');
    req.user = await User.findById(decoded.id)
      .select('-password -likedTracks');
    if (!req.user) return res.status(401).json({ message: 'Пользователь не найден' });
    next();
  } catch (error) {
    res.status(401).json({ message: 'Невалидный токен' });
  }
};

const optionalAuthMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key_change_this');
      req.user = await User.findById(decoded.id);
    }
    next();
  } catch (error) {
    next();
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'super_admin' && req.user.role !== 'venue_admin') {
    return res.status(403).json({ message: 'Доступ запрещен' });
  }
  next();
};

// ============================================
// API МАРШРУТЫ
// ============================================

// === АВТОРИЗАЦИЯ ===
app.post('/api/register', async (req, res) => {
  try {
    // 👇 Добавили platform в извлечение данных
    const { username, email, password, platform } = req.body; 
    
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'Email уже занят' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({ username, email, password: hashedPassword });
    await newUser.save();

    // 👇👇👇 ТЕЛЕГРАМ УВЕДОМЛЕНИЕ (ВСТАВИТЬ СЮДА) 👇👇👇
    const device = platform || 'Неизвестно';
    sendToTelegram(`🚀 <b>Новая регистрация!</b>\n\n👤 Имя: ${username}\n📧 Email: ${email}\n📱 Устройство: ${device}`);
    // 👆👆👆

    const token = jwt.sign({ id: newUser._id, role: newUser.role }, process.env.JWT_SECRET || 'secret_key_change_this', { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: newUser._id, username, email, role: newUser.role } });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера: ' + error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    // 👇 Добавили platform
    const { email, password, platform } = req.body; 
    
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Пользователь не найден' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Неверный пароль' });

    // 👇👇👇 ТЕЛЕГРАМ УВЕДОМЛЕНИЕ (ВСТАВИТЬ СЮДА) 👇👇👇
    const device = platform || 'Неизвестно';
    sendToTelegram(`✅ <b>Вход в аккаунт</b>\n\n👤 Юзер: ${user.username}\n📧 Email: ${email}\n📱 Устройство: ${device}`);
    // 👆👆👆

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret_key_change_this', { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});
// === ПОЛЬЗОВАТЕЛИ ===
app.get('/api/users/me', authMiddleware, async (req, res) => {
  res.json(req.user);
});

app.put('/api/users/me', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { username, bio, location, isPublicProfile, showActivity, allowMessages } = req.body;
    
    console.log('📥 Updating user profile:', req.user._id);
    console.log('Data:', { username, bio, location });
    
    const updates = {};
    
    if (username) updates.username = username;
    if (bio !== undefined) updates.bio = bio;
    if (location !== undefined) updates.location = location;
    if (isPublicProfile !== undefined) updates.isPublicProfile = isPublicProfile === 'true';
    if (showActivity !== undefined) updates.showActivity = showActivity === 'true';
    if (allowMessages !== undefined) updates.allowMessages = allowMessages === 'true';

    // Если загружен новый аватар
    if (req.file) {
      updates.avatar_url = req.file.location; // S3 URL
      console.log('📷 Avatar uploaded:', req.file.location);
    }

    const user = await User.findByIdAndUpdate(
      req.user._id, 
      updates, 
      { new: true }
    ).select('-password');

    console.log('✅ Profile updated successfully');
    res.json(user);
    
  } catch (error) {
    console.error('❌ Error updating profile:', error);
    res.status(500).json({ message: 'Ошибка обновления профиля: ' + error.message });
  }
});
app.get('/api/feed', optionalAuthMiddleware, async (req, res) => { 
  try {
    const { category = 'all', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let query = {};
    let activities = [];

    switch (category) {
      case 'all':
        // 🔥 ВСЁ - показываем абсолютно все активности
        activities = await FeedActivity.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('user_id', 'username avatar_url isVerified role artistInfo stats')
          .populate('track_id')
          .populate('venue_id', 'name')
          .lean();
        break;

      case 'friends':
        // 🔥 ДРУЗЬЯ - только активности от друзей
        if (req.user) {
          const user = await User.findById(req.user._id).select('following');
          const followingIds = user?.following || [];
          
          if (followingIds.length === 0) {
            return res.json([]);
          }

          activities = await FeedActivity.find({ 
            user_id: { $in: followingIds } 
          })
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('user_id', 'username avatar_url isVerified role artistInfo stats')
            .populate('track_id')
            .populate('venue_id', 'name')
            .lean();
        } else {
          return res.json([]);
        }
        break;

      case 'world':
        // 🔥 МИР - музыканты с 10000+ подписчиков
        const worldUsers = await User.find({ 
          'stats.followers': { $gte: 10000 } 
        }).select('_id');
        
        const worldUserIds = worldUsers.map(u => u._id);
        
        if (worldUserIds.length === 0) {
          return res.json([]);
        }

        activities = await FeedActivity.find({ 
          user_id: { $in: worldUserIds } 
        })
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('user_id', 'username avatar_url isVerified role artistInfo stats')
          .populate('track_id')
          .populate('venue_id', 'name')
          .lean();
        break;

      case 'newcomers':
        // 🔥 НОВИЧКИ - пользователи с менее чем 1000 подписчиков
        const newcomerUsers = await User.find({ 
          'stats.followers': { $lt: 1000 }
        }).select('_id');
        
        const newcomerUserIds = newcomerUsers.map(u => u._id);
        
        if (newcomerUserIds.length === 0) {
          return res.json([]);
        }

        activities = await FeedActivity.find({ 
          user_id: { $in: newcomerUserIds },
          type: { $in: ['new_track', 'ordered_track'] }
        })
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('user_id', 'username avatar_url isVerified role artistInfo stats')
          .populate('track_id')
          .populate('venue_id', 'name')
          .lean();
        break;

      default:
        activities = await FeedActivity.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('user_id', 'username avatar_url isVerified role artistInfo stats')
          .populate('track_id')
          .populate('venue_id', 'name')
          .lean();
    }

    // Форматируем результаты
    const formatted = activities.map(activity => {
      const item = {
        _id: activity._id,
        type: activity.type,
        timestamp: activity.timestamp,
        isLive: activity.isLive || false,
        likes: activity.likes || 0,
        comments: activity.comments || 0,
        likedBy: activity.likedBy || [] // 🔥 ДОБАВИЛИ поддержку likedBy
      };

      if (activity.user_id) {
        item.user = {
          _id: activity.user_id._id,
          username: activity.user_id.username,
          avatar_url: activity.user_id.avatar_url || null,
          isVerified: activity.user_id.isVerified || false,
          role: activity.user_id.role,
          artistInfo: activity.user_id.artistInfo
        };
      }

      if (activity.track_id) {
        item.track = {
          _id: activity.track_id._id,
          title: activity.track_id.title,
          artist: activity.track_id.artist,
          cover: activity.track_id.cover,
          genre: activity.track_id.genre,
          duration: activity.track_id.duration,
          audioUrl: activity.track_id.audioUrl
        };
      }

      if (activity.venue_id) {
        item.venue = {
          _id: activity.venue_id._id,
          name: activity.venue_id.name
        };
      }

      if (activity.playlist_name) item.playlist_name = activity.playlist_name;
      if (activity.album_cover) item.album_cover = activity.album_cover;
      if (activity.album_title) item.album_title = activity.album_title;

      return item;
    });

    res.json(formatted);
  } catch (error) {
    console.error('Ошибка загрузки ленты:', error);
    res.status(500).json({ message: 'Ошибка загрузки ленты' });
  }
});

app.get('/api/seed/famous-artists-kz', async (req, res) => {
  try {
    const famousArtists = [
      // 1. Jah Khalib
      {
        username: 'jahkhalib',
        email: 'jahkhalib@sopl.kz',
        password: 'demo123',
        role: 'artist',
        isVerified: true,
        artistInfo: {
          stageName: 'Jah Khalib',
          genre: ['Hip-Hop', 'R&B'],
          bio: 'Казахстанский рэпер, певец, битмейкер и продюсер.',
          donationEnabled: true,
          socialLinks: { instagram: 'https://instagram.com/jahkhalib' }
        },
        // Фото: Мужчина в темной одежде, атмосферное
        avatar_url: 'https://images.unsplash.com/photo-1563240619-44ec0047592c?w=400&h=400&fit=crop',
        stats: { followers: 450200, following: 15, playlists: 2 }
      },
      // 2. Ninety One
      {
        username: 'ninetyone',
        email: '91@sopl.kz',
        password: 'demo123',
        role: 'artist',
        isVerified: true,
        artistInfo: {
          stageName: 'Ninety One',
          genre: ['Q-Pop', 'Pop'],
          bio: 'Основоположники жанра Q-Pop. Бойз-бэнд, изменивший музыку в Казахстане.',
          donationEnabled: true,
          socialLinks: { instagram: 'https://instagram.com/ninetyone' }
        },
        // Фото: Яркая группа / стиль
        avatar_url: 'https://images.unsplash.com/photo-1529359744902-86b2ab9cd070?w=400&h=400&fit=crop',
        stats: { followers: 890000, following: 0, playlists: 5 }
      },
      // 3. Dimash
      {
        username: 'kudaibergenov.dimash',
        email: 'dimash@sopl.kz',
        password: 'demo123',
        role: 'artist',
        isVerified: true,
        artistInfo: {
          stageName: 'Dimash Qudaibergen',
          genre: ['Pop', 'Classical'],
          bio: 'Всемирно известный певец, уникальный вокальный диапазон.',
          donationEnabled: true,
        },
        // Фото: Сцена, свет, выступление
        avatar_url: 'https://images.unsplash.com/photo-1516280440614-6697288d5d38?w=400&h=400&fit=crop',
        stats: { followers: 1500000, following: 40, playlists: 10 }
      },
      // 4. Asik (ВМЕСТО Say Mo)
      {
        username: 'asik_official',
        email: 'asik@sopl.kz',
        password: 'demo123',
        role: 'artist',
        isVerified: true,
        artistInfo: {
          stageName: 'Asik',
          genre: ['Pop', 'Lyrical'],
          bio: 'Яркий представитель современной казахстанской лирики.',
          donationEnabled: true,
        },
        // Фото: Стильный парень с гитарой или микрофоном
        avatar_url: 'https://images.unsplash.com/photo-1508606572321-901ea443707f?w=400&h=400&fit=crop',
        stats: { followers: 120000, following: 10, playlists: 1 }
      }
    ];

    const createdArtists = [];

    // Рабочие ссылки на аудио (разные, чтобы не скучно было)
    const audioSamples = [
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', // Спокойная
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', // Поп
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3', // Электроника
      'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3' // Динамичная
    ];

    // Набор гарантированно рабочих красивых обложек для треков
    const coverImages = [
      'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=600&h=600&fit=crop', // DJ/Music
      'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&h=600&fit=crop', // Microphone
      'https://images.unsplash.com/photo-1514525253440-b393452e3383?w=600&h=600&fit=crop', // Neon City
      'https://images.unsplash.com/photo-1493225255756-d9584f8606e9?w=600&h=600&fit=crop', // Vibe
      'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=600&h=600&fit=crop'  // Concert
    ];

    for (const artistData of famousArtists) {
      const existing = await User.findOne({ email: artistData.email });
      if (existing) {
        console.log(`Артист ${artistData.artistInfo.stageName} уже существует`);
        continue;
      }

      const hashedPassword = await bcrypt.hash(artistData.password, 10);
      const artist = new User({
        ...artistData,
        password: hashedPassword
      });

      await artist.save();
      createdArtists.push(artist);

      // Настройка треков под каждого артиста
      let trackTitles = [];
      
      if (artist.username === 'jahkhalib') {
        trackTitles = ['Медина', 'Лейла', 'Созвездие'];
      } else if (artist.username === 'ninetyone') {
        trackTitles = ['Mooz', 'Ah! Yah! Mah!', 'Oinama'];
      } else if (artist.username === 'kudaibergenov.dimash') {
        trackTitles = ['SOS', 'Stranger', 'Love'];
      } else if (artist.username === 'asik_official') {
        // Треки для Asik
        trackTitles = ['Mahabbat', 'Jurek', 'Sen'];
      }

      // Создаем треки
      for (let i = 0; i < trackTitles.length; i++) {
        // Выбираем аудио и обложку по кругу, чтобы не повторялись подряд
        const audioUrl = audioSamples[(i + createdArtists.length) % audioSamples.length];
        const coverUrl = coverImages[(i + createdArtists.length) % coverImages.length];

        const track = new Track({
          title: trackTitles[i],
          artist: artistData.artistInfo.stageName,
          artistId: artist._id,
          cover: coverUrl, // Используем надежную ссылку
          duration: 180 + (i * 20),
          genre: artistData.artistInfo.genre[0],
          audioUrl: audioUrl, // Рабочая музыка
          uploadedBy: artist._id,
          isApproved: true,
          likes: Math.floor(Math.random() * 5000) + 500,
          playCount: Math.floor(Math.random() * 50000) + 1000
        });

        await track.save();

        const activity = new FeedActivity({
          type: 'new_track',
          user_id: artist._id,
          track_id: track._id,
          timestamp: new Date()
        });
        await activity.save();
      }
    }

    res.json({ 
      message: `Успешно добавлено ${createdArtists.length} KZ артистов`,
      artists: createdArtists.map(a => a.artistInfo.stageName)
    });

  } catch (error) {
    console.error('Error seeding artists:', error);
    res.status(500).json({ message: 'Ошибка: ' + error.message });
  }
});
function formatFollowers(num) {
  if (!num || num < 1000) return num || 0;
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace('.0', '') + ' млн';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace('.0', '') + ' тыс';
  }
  return num;
}

// Замени эндпоинт /api/search/trending

// Кэш для trending (обновляется раз в 60 секунд)
let trendingCache = null;
let trendingCacheTime = 0;
const TRENDING_CACHE_TTL = 60 * 1000; // 60 секунд

app.get('/api/search/trending', optionalAuthMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    if (trendingCache && (now - trendingCacheTime) < TRENDING_CACHE_TTL) {
      return res.json(trendingCache);
    }

    const [topTracks, topArtists] = await Promise.all([
      Track.find({ isApproved: true })
        .sort({ likes: -1, playCount: -1 })
        .limit(10)
        .select('title artist cover duration genre likes playCount audioUrl artistId')
        .lean(),
      User.find({ 
          role: { $in: ['artist', 'user'] },
          'stats.followers': { $gt: 0 }
        })
        .sort({ 'stats.followers': -1 })
        .limit(5)
        .select('username avatar_url isVerified stats role')
        .lean()
    ]);

    const formattedArtists = topArtists.map(artist => ({
      ...artist,
      stats: {
        ...artist.stats,
        followersFormatted: formatFollowers(artist.stats?.followers)
      }
    }));

    const result = { tracks: topTracks, artists: formattedArtists };
    trendingCache = result;
    trendingCacheTime = now;

    res.json(result);
  } catch (error) {
    console.error('Ошибка загрузки трендов:', error);
    res.status(500).json({ message: 'Ошибка загрузки трендов' });
  }
});
// === ПОИСК ===
app.get('/api/users/:id/is-following', authMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user._id.toString();
    
    const isFollowing = (req.user.following || [])
      .map(id => id.toString())
      .includes(targetUserId);
    
    const isOwn = currentUserId === targetUserId;
    
    res.json({ isFollowing, isOwn });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});
app.get('/api/search', optionalAuthMiddleware, async (req, res) => {
  try {
    const { q, type } = req.query;
    const result = {};

    if (!type || type === 'tracks' || type === 'all') {
      result.tracks = await Track.find({
        $or: [
          { title: new RegExp(q, 'i') },
          { artist: new RegExp(q, 'i') }
        ],
        isApproved: true // ТОЛЬКО ОДОБРЕННЫЕ ТРЕКИ
      }).limit(10);
    }

    if (!type || type === 'venues' || type === 'all') {
      result.venues = await Venue.find({
        name: new RegExp(q, 'i')
      }).limit(10);
    }

    if (!type || type === 'users' || type === 'artists' || type === 'all') {
      result.users = await User.find({
        username: new RegExp(q, 'i')
      }).select('-password').limit(10);
      
      if (type === 'artists') {
        result.artists = result.users;
        delete result.users;
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка поиска' });
  }
});
app.post('/api/feed/:id/like', authMiddleware, async (req, res) => {
  try {
    const activityId = req.params.id;
    const userId = req.user._id;

    const activity = await FeedActivity.findById(activityId);
    if (!activity) {
      return res.status(404).json({ message: 'Активность не найдена' });
    }

    // Инициализируем массив лайков если его нет
    if (!activity.likedBy) {
      activity.likedBy = [];
    }

    const likedIndex = activity.likedBy.findIndex(id => id.toString() === userId.toString());
    let isLiked;

    if (likedIndex > -1) {
      // 🔥 Убираем лайк
      activity.likedBy.splice(likedIndex, 1);
      activity.likes = Math.max(0, (activity.likes || 0) - 1);
      isLiked = false;
    } else {
      // 🔥 Добавляем лайк
      activity.likedBy.push(userId);
      activity.likes = (activity.likes || 0) + 1;
      isLiked = true;
    }

    await activity.save();

    // 🔥 Возвращаем актуальные данные
    res.json({ 
      success: true,
      isLiked,
      likes: activity.likes,
      likedBy: activity.likedBy
    });
  } catch (error) {
    console.error('Ошибка лайка активности:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});
app.delete('/api/feed/:id', authMiddleware, async (req, res) => {
  try {
    const activityId = req.params.id;
    const userId = req.user._id;

    const activity = await FeedActivity.findById(activityId);
    
    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    // Проверяем, что пользователь владелец активности
    if (activity.user_id.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized to delete this activity' });
    }

    await FeedActivity.findByIdAndDelete(activityId);
    
    res.json({ success: true, message: 'Activity deleted' });
  } catch (error) {
    console.error('Delete activity error:', error);
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});
// Добавить комментарий к активности
app.post('/api/feed/:id/comment', authMiddleware, async (req, res) => {
  try {
    const activityId = req.params.id;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Текст комментария обязателен' });
    }

    const activity = await FeedActivity.findById(activityId);
    if (!activity) {
      return res.status(404).json({ message: 'Активность не найдена' });
    }

    // Создаём простую коллекцию комментариев
    const CommentSchema = new mongoose.Schema({
      activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedActivity', required: true },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      text: { type: String, required: true },
      createdAt: { type: Date, default: Date.now }
    });
    
    const Comment = mongoose.models.Comment || mongoose.model('Comment', CommentSchema);

    const newComment = new Comment({
      activityId,
      userId: req.user._id,
      text: text.trim()
    });

    await newComment.save();

    // Увеличиваем счётчик комментариев
    activity.comments = (activity.comments || 0) + 1;
    await activity.save();

    // Возвращаем комментарий с данными пользователя
    const populatedComment = await Comment.findById(newComment._id)
      .populate('userId', 'username avatar_url');

    res.status(201).json({
      comment: {
        _id: populatedComment._id,
        text: populatedComment.text,
        user: {
          _id: populatedComment.userId._id,
          username: populatedComment.userId.username,
          avatar_url: populatedComment.userId.avatar_url
        },
        createdAt: populatedComment.createdAt
      },
      comments: activity.comments
    });
  } catch (error) {
    console.error('Ошибка добавления комментария:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить комментарии к активности
app.get('/api/feed/:id/comments', async (req, res) => {
  try {
    const activityId = req.params.id;

    // Используем модель Comment (которую создали выше)
    const Comment = mongoose.model('Comment');

    const comments = await Comment.find({ activityId })
      .populate('userId', 'username avatar_url')
      .sort({ createdAt: -1 })
      .limit(50);

    const formattedComments = comments.map(c => ({
      _id: c._id,
      text: c.text,
      user: {
        _id: c.userId._id,
        username: c.userId.username,
        avatar_url: c.userId.avatar_url
      },
      createdAt: c.createdAt
    }));

    res.json(formattedComments);
  } catch (error) {
    console.error('Ошибка загрузки комментариев:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});
// === ТРЕКИ ===
app.get('/api/tracks', async (req, res) => {
  try {
    const tracks = await Track.find({ isApproved: true }).limit(50);
    res.json(tracks);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки треков' });
  }
});

app.get('/api/tracks/:id', async (req, res) => {
  try {
    const track = await Track.findById(req.params.id);
    if (!track) return res.status(404).json({ message: 'Трек не найден' });
    res.json(track);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// 🔥 НОВЫЙ ЭНДПОИНТ: Загрузка трека с модерацией
app.post('/api/tracks/upload', authMiddleware, upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, artist, album, duration, genre } = req.body;
    
    const audioFile = req.files['audio'] ? req.files['audio'][0] : null;
    const coverFile = req.files['cover'] ? req.files['cover'][0] : null;

    if (!audioFile) {
      return res.status(400).json({ message: 'Аудио файл обязателен' });
    }

    const newTrack = new Track({
      title,
      artist,
      album,
      duration: parseInt(duration),
      genre,
      cover: coverFile ? coverFile.location : 'https://via.placeholder.com/300',
      audioUrl: audioFile.location, 
      uploadedBy: req.user._id,
      artistId: req.user._id, // 🔥 ДОБАВИЛИ artistId
      isApproved: false // 🔥 ВСЕГДА FALSE при загрузке
    });

    await newTrack.save();

    // 🔥 НЕ СОЗДАЁМ АКТИВНОСТЬ ДО ОДОБРЕНИЯ!
    // Активность создастся только после одобрения админом

    res.status(201).json({ 
      message: 'Трек загружен и отправлен на модерацию', 
      track: newTrack 
    });
  } catch (error) {
    console.error('Ошибка загрузки трека:', error);
    res.status(500).json({ message: 'Ошибка загрузки трека: ' + error.message });
  }
});
app.post('/api/artist/apply', authMiddleware, upload.array('samples', 3), async (req, res) => {
  try {
    const { stageName, genre, bio, instagram, youtube, spotify } = req.body;

    // Проверяем, нет ли уже активной заявки
    const existingApp = await ArtistApplication.findOne({
      userId: req.user._id,
      status: 'pending'
    });

    if (existingApp) {
      return res.status(400).json({ message: 'У вас уже есть активная заявка' });
    }

    // Если пользователь уже артист
    if (req.user.role === 'artist') {
      return res.status(400).json({ message: 'Вы уже являетесь артистом' });
    }

    const sampleTracks = req.files ? req.files.map(f => f.location) : [];

    const application = new ArtistApplication({
      userId: req.user._id,
      stageName: stageName || req.user.username,
      genre: typeof genre === 'string' ? genre.split(',').map(g => g.trim()) : genre,
      bio,
      socialLinks: { instagram, youtube, spotify },
      sampleTracks,
      status: 'pending'
    });

    await application.save();

    res.status(201).json({ 
      message: 'Заявка отправлена на рассмотрение',
      application 
    });
  } catch (error) {
    console.error('Error creating artist application:', error);
    res.status(500).json({ message: 'Ошибка отправки заявки: ' + error.message });
  }
});

// Получить статус заявки
app.get('/api/artist/application/status', authMiddleware, async (req, res) => {
  try {
    const application = await ArtistApplication.findOne({
      userId: req.user._id
    }).sort({ createdAt: -1 });

    if (!application) {
      return res.json({ hasApplication: false });
    }

    res.json({ 
      hasApplication: true,
      status: application.status,
      application 
    });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки заявки' });
  }
});
app.post('/api/tracks/:id/like', authMiddleware, async (req, res) => {
  try {
    const trackId = req.params.id;
    const user = await User.findById(req.user._id);
    const track = await Track.findById(trackId);

    if (!track) return res.status(404).json({ message: 'Трек не найден' });

    const isAlreadyLiked = user.likedTracks.includes(trackId);

    if (isAlreadyLiked) {
      user.likedTracks.pull(trackId);
      await Track.findByIdAndUpdate(trackId, { $inc: { likes: -1 } });
    } else {
      user.likedTracks.push(trackId);
      await Track.findByIdAndUpdate(trackId, { $inc: { likes: 1 } });

      // Уведомление автору трека
      if (track.uploadedBy && track.uploadedBy.toString() !== req.user._id.toString()) {
        await createNotification(
          track.uploadedBy,
          req.user._id,
          'like',
          `лайкнул ваш трек "${track.title}"`,
          trackId
        );
      }

      // 🔥 НОВОЕ: Уведомление подписчикам о добавлении в избранное
      if (user.followers && user.followers.length > 0) {
        for (const followerId of user.followers) {
          await createNotification(
            followerId,
            req.user._id,
            'liked_track',
            `добавил в избранное трек "${track.title}"`,
            trackId
          );
        }
      }

      // Создаём активность в ленте
      const newActivity = new FeedActivity({
        type: 'liked_track',
        user_id: req.user._id,
        track_id: trackId,
        timestamp: new Date()
      });
      await newActivity.save();
    }

    await user.save();
    res.json({ isLiked: !isAlreadyLiked, trackId });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка при лайке' });
  }
});

// === ЗАВЕДЕНИЯ ===
app.get('/api/venues', async (req, res) => {
  try {
    const venues = await Venue.find({ isActive: true });
    res.json(venues);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки заведений' });
  }
});
app.get('/api/users/me/stats', authMiddleware, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    const userId = req.user._id;

    console.log('📊 Fetching stats for user:', userId, 'period:', period);

    // Определяем диапазон дат
    const now = new Date();
    let startDate = new Date();

    switch (period) {
      case 'week':
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(now.getMonth() - 1);
        break;
      case 'year':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
    }

    // 1. Общая статистика пользователя
    const user = await User.findById(userId);
    const playlists = await Playlist.countDocuments({ owner_id: userId });
    const likedTracks = user.likedTracks.length;

    // 2. История прослушиваний (из FeedActivity)
    const listeningHistory = await FeedActivity.find({
      user_id: userId,
      type: 'listening_now',
      timestamp: { $gte: startDate }
    }).populate('track_id');

    console.log('Found', listeningHistory.length, 'listening activities');

    // 3. Топ артистов
    const artistCounts = {};
    listeningHistory.forEach(activity => {
      if (activity.track_id?.artist) {
        const artist = activity.track_id.artist;
        artistCounts[artist] = (artistCounts[artist] || 0) + 1;
      }
    });

    const topArtists = Object.entries(artistCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => ({ name, playCount: count }));

    // 4. Топ жанров
    const genreCounts = {};
    listeningHistory.forEach(activity => {
      if (activity.track_id?.genre) {
        const genre = activity.track_id.genre;
        genreCounts[genre] = (genreCounts[genre] || 0) + 1;
      }
    });

    const totalPlays = listeningHistory.length || 1;

    const topGenres = Object.entries(genreCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => ({
        name,
        count,
        percentage: Math.round((count / totalPlays) * 100)
      }));

    // 5. Активность по дням (последние 7 дней)
    const recentActivity = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);

      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const count = await FeedActivity.countDocuments({
        user_id: userId,
        type: 'listening_now',
        timestamp: { $gte: date, $lt: nextDate }
      });

      recentActivity.push({
        date: date.toISOString().split('T')[0],
        tracksPlayed: count
      });
    }

    // 6. Месячная статистика (последние 6 месяцев)
    const monthlyStats = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);

      const count = await FeedActivity.countDocuments({
        user_id: userId,
        type: 'listening_now',
        timestamp: { $gte: monthStart, $lte: monthEnd }
      });

      monthlyStats.push({
        month: monthStart.toLocaleDateString('ru-RU', { month: 'short' }),
        hours: Math.round(count * 3 / 60) // Примерно 3 минуты на трек
      });
    }

    // Формируем ответ
    const stats = {
      totalListeningTime: listeningHistory.length * 180, // 3 минуты * 60 секунд
      totalTracks: likedTracks,
      totalPlaylists: playlists,
      topArtists,
      topGenres,
      recentActivity,
      monthlyStats
    };

    console.log('✅ Stats generated:', stats);
    res.json(stats);

  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ message: 'Ошибка загрузки статистики: ' + error.message });
  }
});

app.get('/api/venues/qr/:code', async (req, res) => {
  try {
    const code = req.params.code;
    
    let venue = null;
    
    // 🔥 ПОДДЕРЖКА ОБОИХ ФОРМАТОВ
    // 1. Старый формат: SOPL_venue_xxx
    if (code.startsWith('SOPL_venue_')) {
      venue = await Venue.findOne({ qr_code: code });
    }
    // 2. Новый формат: извлекаем venueId из URL
    else {
      // Ищем по venue_id напрямую
      venue = await Venue.findOne({ venue_id: code });
      
      // Или если передали весь URL
      if (!venue && code.includes('sopl.app/venue/')) {
        const match = code.match(/sopl\.app\/venue\/([a-zA-Z0-9-]+)/);
        if (match) {
          venue = await Venue.findOne({ venue_id: match[1] });
        }
      }
    }
    
    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }
    
    res.json(venue);
  } catch (error) {
    console.error('Error finding venue:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

app.get('/api/venues/:id', authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const venue = await Venue.findById(venueId).populate('currentlyPlayingId');
    
    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }

    // 🔥 ПРОВЕРКА ДОСТУПА
    // Только super_admin или venue_admin этого заведения может получить данные
    const isOwner = venue.ownerUserId && venue.ownerUserId.toString() === req.user._id.toString();
    const isAdmin = venue.admins && venue.admins.some(adminId => adminId.toString() === req.user._id.toString());
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAssignedVenueAdmin = req.user.role === 'venue_admin' && req.user.venue_id && req.user.venue_id.toString() === venueId;

    // Если пользователь не имеет доступа
    if (!isOwner && !isAdmin && !isSuperAdmin && !isAssignedVenueAdmin) {
      return res.status(403).json({ 
        message: 'Нет доступа к этому заведению'
      });
    }

    res.json(venue);
  } catch (error) {
    console.error('Error fetching venue:', error);
    res.status(500).json({ message: 'Ошибка сервера: ' + error.message });
  }
});
app.get('/api/venues/my/venue', authMiddleware, async (req, res) => {
  try {
    console.log('📡 [my/venue] Запрос от пользователя:', req.user.username, 'ID:', req.user._id);
    console.log('📡 [my/venue] Роль:', req.user.role);
    console.log('📡 [my/venue] venue_id:', req.user.venue_id);

    // Проверяем, что пользователь - venue_admin
    if (req.user.role !== 'venue_admin') {
      return res.status(403).json({ 
        message: 'Доступно только для администраторов заведений' 
      });
    }

    let venue = null;

    // Способ 1: Ищем по venue_id пользователя
    if (req.user.venue_id) {
      venue = await Venue.findById(req.user.venue_id).populate('currentlyPlayingId');
      console.log('🔍 Поиск по venue_id:', venue ? 'найдено' : 'не найдено');
    }

    // Способ 2: Если не нашли, ищем по ownerUserId
    if (!venue) {
      venue = await Venue.findOne({ ownerUserId: req.user._id }).populate('currentlyPlayingId');
      console.log('🔍 Поиск по ownerUserId:', venue ? 'найдено' : 'не найдено');
      
      // Если нашли - обновляем venue_id у пользователя для будущих запросов
      if (venue) {
        await User.findByIdAndUpdate(req.user._id, { venue_id: venue._id });
        console.log('✅ Автоматически обновлен venue_id пользователя');
      }
    }

    // Если ничего не нашли - ошибка
    if (!venue) {
      return res.status(404).json({ 
        message: 'У вас не назначено заведение. Обратитесь к администратору системы.' 
      });
    }

    console.log('✅ [my/venue] Заведение найдено:', venue.name);
    res.json(venue);
    
  } catch (error) {
    console.error('❌ [my/venue] Error:', error);
    res.status(500).json({ message: 'Ошибка сервера: ' + error.message });
  }
});
// === МУЗЫКАЛЬНАЯ ОЧЕРЕДЬ ===
app.post('/api/venues/:id/queue', authMiddleware, async (req, res) => {
  try {
    const { trackId, tableNumber, comment } = req.body;
    const venueId = req.params.id;

    // ВАЛИДАЦИЯ: Проверяем, что venueId — валидный ObjectId
    if (!mongoose.Types.ObjectId.isValid(venueId)) {
      return res.status(400).json({ message: 'Невалидный ID заведения' });
    }

    // Проверяем существование заведения
    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }

    // ВАЛИДАЦИЯ: Проверяем trackId
    if (!mongoose.Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({ message: 'Невалидный ID трека' });
    }

    // Проверяем существование трека
    const track = await Track.findById(trackId);
    if (!track) {
      return res.status(404).json({ message: 'Трек не найден' });
    }

    if (!track.isApproved) {
      return res.status(403).json({ message: 'Трек не прошёл модерацию' });
    }

    // Создаём новый элемент очереди
    const newQueueItem = new Queue({
      venue_id: venueId,
      track_id: trackId,
      user_id: req.user._id,
      table_number: tableNumber,
      comment: comment,
    });
    await newQueueItem.save();

    console.log('✅ New track added to queue:', track.title);

    // Загружаем полную очередь с populate
    const fullQueue = await Queue
      .find({ venue_id: venueId, status: { $ne: 'completed' } })
      .sort({ created_at: 1 })
      .populate('track_id', 'title artist cover duration genre audioUrl')
      .populate('user_id', 'username avatar_url');

    console.log('📡 Broadcasting queue update. Total items:', fullQueue.length);

    // 🔥 ИСПРАВЛЕННЫЙ БРОДКАСТ - отправляем ПОЛНЫЕ данные
    broadcastToVenue(venueId, { 
      type: 'queue_update', 
      queue: fullQueue.map(q => ({
        _id: q._id,
        status: q.status,
        track: {
          _id: q.track_id._id,
          title: q.track_id.title,
          artist: q.track_id.artist,
          cover: q.track_id.cover,
          duration: q.track_id.duration,
          genre: q.track_id.genre,
          audioUrl: q.track_id.audioUrl
        },
        user: {
          _id: q.user_id._id,
          username: q.user_id.username,
          avatar_url: q.user_id.avatar_url
        },
        created_at: q.created_at,
        table_number: q.table_number,
        comment: q.comment
      }))
    });

    // Возвращаем созданный элемент с populate
    const populated = await Queue.findById(newQueueItem._id)
      .populate('track_id')
      .populate('user_id', 'username avatar_url');

    res.status(201).json(populated);

  } catch (error) {
    console.error('❌ Ошибка добавления в очередь:', error);
    res.status(500).json({ message: 'Ошибка добавления в очередь: ' + (error.message || 'Неизвестная ошибка') });
  }
});

app.get('/api/venues/:id/queue', async (req, res) => {
  try {
    const queue = await Queue.find({
      venue_id: req.params.id,
      status: { $ne: 'completed' }
    })
      .sort({ created_at: 1 })
      .populate('track_id', 'title artist cover duration genre audioUrl')
      .populate('user_id', 'username avatar_url');

    res.json(queue.map(q => ({
      _id: q._id,
      track: q.track_id,
      user: q.user_id,
      status: q.status,
      table_number: q.table_number,
      comment: q.comment,
      created_at: q.created_at
    })));
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки очереди' });
  }
});

app.patch('/api/queue/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;

    const queueItem = await Queue.findByIdAndUpdate(
      req.params.id,
      {
        status,
        ...(status === 'playing'   && { started_at: new Date() }),
        ...(status === 'completed' && { completed_at: new Date() }),
      },
      { new: true }
    );

    if (!queueItem) return res.status(404).json({ message: 'Элемент очереди не найден' });

    const venueId = queueItem.venue_id.toString();

    // 🔊 Трек начал играть — шлём его десктопному плею
    if (status === 'playing') {
      const track = await Track.findById(queueItem.track_id);
      if (track) {
        broadcastToVenue(venueId, { type: 'now_playing', track });
      }
    }

    // ⏹️  Трек завершён или отклонён
    if (status === 'completed' || status === 'rejected') {
      broadcastToVenue(venueId, { type: 'track_completed', queue_id: queueItem._id });
    }

    // 🔄 Обновление очереди (чтобы десктоп видел актуальный список)
    const updatedQueue = await Queue
      .find({ venue_id: venueId, status: { $ne: 'completed' } })
      .sort({ created_at: 1 })
      .populate('track_id')
      .populate('user_id', 'username avatar_url');

    broadcastToVenue(venueId, { 
      type: 'queue_update', 
      queue: updatedQueue.map(q => ({
        _id: q._id,
        status: q.status,
        track: q.track_id ? {
          title: q.track_id.title,
          artist: q.track_id.artist,
          cover: q.track_id.cover,
          audioUrl: q.track_id.audioUrl
        } : null,
        user: q.user_id ? {
          username: q.user_id.username,
          avatar_url: q.user_id.avatar_url
        } : null,
        created_at: q.created_at
      }))
    });

    res.json(queueItem);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления статуса' });
  }
});


app.delete('/api/queue/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Queue.findByIdAndDelete(req.params.id);
    res.json({ message: 'Удалено из очереди' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка удаления' });
  }
});

// ============================================
// 🔥 АДМИНКА - НОВЫЕ ЭНДПОИНТЫ
// ============================================
app.get('/api/admin/artist-applications', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // 🔥 ИСПРАВЛЕНО: показываем ТОЛЬКО pending заявки
    const applications = await ArtistApplication.find({ status: 'pending' })
      .populate('userId', 'username email avatar_url')
      .sort({ createdAt: -1 });

    res.json(applications);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки заявок' });
  }
});

// Одобрить заявку на артиста
app.patch('/api/admin/artist-applications/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const application = await ArtistApplication.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({ message: 'Заявка не найдена' });
    }

    // Обновляем пользователя
    await User.findByIdAndUpdate(application.userId, {
      role: 'artist',
      isVerified: true,
      artistInfo: {
        stageName: application.stageName,
        genre: application.genre,
        bio: application.bio,
        socialLinks: application.socialLinks,
        donationEnabled: true
      }
    });

    // Обновляем статус заявки
    application.status = 'approved';
    application.reviewedBy = req.user._id;
    application.reviewedAt = new Date();
    await application.save();

    // Создаём уведомление
    await createNotification(
      application.userId,
      req.user._id,
      'new_track',
      'Ваша заявка на статус артиста одобрена! 🎉'
    );

    res.json({ message: 'Заявка одобрена', application });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка одобрения заявки' });
  }
});
app.post('/api/venues/:id/rate', authMiddleware, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const venueId = req.params.id;
    const userId = req.user._id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Рейтинг должен быть от 1 до 5' });
    }

    const venue = await Venue.findById(venueId);
    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }

    // Проверяем, есть ли уже отзыв от этого пользователя
    const existingReview = await VenueReview.findOne({ venue_id: venueId, user_id: userId });

    if (existingReview) {
      return res.status(400).json({ message: 'Вы уже оценили это заведение' });
    }

    // Создаём новый отзыв
    const newReview = new VenueReview({
      venue_id: venueId,
      user_id: userId,
      rating,
      comment: comment?.trim() || ''
    });

    await newReview.save();

    // Пересчитываем средний рейтинг заведения
    const allReviews = await VenueReview.find({ venue_id: venueId });
    const totalRating = allReviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / allReviews.length;

    // Обновляем заведение
    venue.rating = averageRating;
    venue.reviewCount = allReviews.length;
    await venue.save();

    res.status(201).json({ 
      message: 'Отзыв добавлен', 
      review: newReview,
      venue: {
        rating: venue.rating,
        reviewCount: venue.reviewCount
      }
    });

  } catch (error) {
    console.error('Error rating venue:', error);
    res.status(500).json({ message: 'Ошибка сохранения оценки' });
  }
});

// Получить отзывы заведения
app.get('/api/venues/:id/reviews', async (req, res) => {
  try {
    const venueId = req.params.id;

    const reviews = await VenueReview.find({ venue_id: venueId })
      .populate('user_id', 'username avatar_url')
      .sort({ createdAt: -1 })
      .limit(50);

    const formatted = reviews.map(review => ({
      _id: review._id,
      rating: review.rating,
      comment: review.comment,
      user: {
        _id: review.user_id._id,
        username: review.user_id.username,
        avatar_url: review.user_id.avatar_url
      },
      createdAt: review.createdAt
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ message: 'Ошибка загрузки отзывов' });
  }
});

// Проверить, оставил ли пользователь отзыв
app.get('/api/venues/:id/my-review', authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const userId = req.user._id;

    const review = await VenueReview.findOne({ venue_id: venueId, user_id: userId });

    res.json({ 
      hasReview: !!review,
      review: review ? {
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt
      } : null
    });
  } catch (error) {
    console.error('Error checking review:', error);
    res.status(500).json({ message: 'Ошибка проверки отзыва' });
  }
});

// Получить публичную информацию о заведении (без auth)
app.get('/api/venues/public/:id', async (req, res) => {
  try {
    const venueId = req.params.id;

    const venue = await Venue.findById(venueId).select('-admins -ownerUserId');

    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }

    res.json(venue);
  } catch (error) {
    console.error('Error fetching venue:', error);
    res.status(500).json({ message: 'Ошибка загрузки заведения' });
  }
});

// Удалить свой отзыв (опционально)
app.delete('/api/venues/:id/my-review', authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const userId = req.user._id;

    const review = await VenueReview.findOneAndDelete({ venue_id: venueId, user_id: userId });

    if (!review) {
      return res.status(404).json({ message: 'Отзыв не найден' });
    }

    // Пересчитываем рейтинг
    const venue = await Venue.findById(venueId);
    const allReviews = await VenueReview.find({ venue_id: venueId });

    if (allReviews.length > 0) {
      const totalRating = allReviews.reduce((sum, r) => sum + r.rating, 0);
      venue.rating = totalRating / allReviews.length;
    } else {
      venue.rating = 0;
    }

    venue.reviewCount = allReviews.length;
    await venue.save();

    res.json({ message: 'Отзыв удалён' });
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({ message: 'Ошибка удаления отзыва' });
  }
});

// Отклонить заявку
app.patch('/api/admin/artist-applications/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const application = await ArtistApplication.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({ message: 'Заявка не найдена' });
    }

    application.status = 'rejected';
    application.reviewedBy = req.user._id;
    application.reviewedAt = new Date();
    application.rejectionReason = reason;
    await application.save();

    await createNotification(
      application.userId,
      req.user._id,
      'new_track',
      `Ваша заявка на статус артиста отклонена${reason ? ': ' + reason : ''}`
    );

    res.json({ message: 'Заявка отклонена', application });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка отклонения заявки' });
  }
});
app.get('/api/artists/:id/tracks', async (req, res) => {
  try {
    const tracks = await Track.find({ 
      uploadedBy: req.params.id,
      isApproved: true 
    }).sort({ createdAt: -1 });

    res.json(tracks);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки треков артиста' });
  }
});
// Получить все треки на модерацию
app.get('/api/admin/tracks/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const pendingTracks = await Track.find({ isApproved: false })
      .populate('uploadedBy', 'username email')
      .sort({ createdAt: -1 });
    res.json(pendingTracks);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки треков на модерацию' });
  }
});

// Одобрить трек
app.patch('/api/admin/tracks/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const track = await Track.findByIdAndUpdate(
      req.params.id,
      { isApproved: true },
      { new: true }
    ).populate('uploadedBy', 'username _id');

    if (!track) {
      return res.status(404).json({ message: 'Трек не найден' });
    }

    // Создаём активность в ленте
    const newActivity = new FeedActivity({
      type: 'new_track',
      user_id: track.uploadedBy._id,
      track_id: track._id,
      timestamp: new Date()
    });
    await newActivity.save();

    // Уведомление артисту
    await createNotification(
      track.uploadedBy._id,
      req.user._id,
      'new_track',
      `Ваш трек "${track.title}" одобрен и опубликован! 🎉`,
      track._id
    );

    // 🔥 НОВОЕ: Уведомления ВСЕМ подписчикам артиста
    const artist = await User.findById(track.uploadedBy._id);
    if (artist && artist.followers && artist.followers.length > 0) {
      for (const followerId of artist.followers) {
        await createNotification(
          followerId,
          track.uploadedBy._id,
          'new_track',
          `выпустил новый трек: "${track.title}"`,
          track._id
        );
      }
      console.log(`✅ Отправлено ${artist.followers.length} уведомлений подписчикам`);
    }

    res.json({ message: 'Трек одобрен', track });
  } catch (error) {
    console.error('Ошибка одобрения:', error);
    res.status(500).json({ message: 'Ошибка одобрения трека' });
  }
});
app.delete('/api/admin/tracks/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const track = await Track.findById(req.params.id).populate('uploadedBy');
    
    if (!track) {
      return res.status(404).json({ message: 'Трек не найден' });
    }

    // 🔥 УДАЛЯЕМ АКТИВНОСТЬ ИЗ ЛЕНТЫ (если была создана случайно)
    await FeedActivity.deleteMany({ track_id: track._id });

    // 🔥 ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ АРТИСТУ
    await createNotification(
      track.uploadedBy._id,
      req.user._id,
      'new_track',
      `Ваш трек "${track.title}" отклонён модератором`,
      track._id
    );

    // 🔥 УДАЛЯЕМ ТРЕК
    await Track.findByIdAndDelete(req.params.id);

    res.json({ message: 'Трек отклонён и удалён' });
  } catch (error) {
    console.error('Ошибка отклонения:', error);
    res.status(500).json({ message: 'Ошибка отклонения трека' });
  }
});

// Получить всех пользователей (для управления ролями)
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки пользователей' });
  }
});

// Изменить роль пользователя
app.patch('/api/admin/users/:id/role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { role } = req.body;
    
    // Проверка: только super_admin может назначать других super_admin
    if (role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Только супер-админ может назначать других супер-админов' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select('-password');
    
    res.json({ message: 'Роль обновлена', user });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления роли' });
  }
});
app.post('/api/admin/venues', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, ownerEmail, address, hours, photo_url } = req.body;

    if (!name) return res.status(400).json({ message: 'Название обязательно' });
    if (!ownerEmail) return res.status(400).json({ message: 'Email владельца обязателен' });

    // Ищем юзера по email
    const owner = await User.findOne({ email: ownerEmail });
    if (!owner) {
      return res.status(404).json({ message: `Пользователь с email "${ownerEmail}" не найден` });
    }

    // 🔥 НОВОЕ: Генерируем venueId и URL-формат QR-кода
    const { v4: uuidv4 } = require('uuid'); // Добавь в начало файла если нет
    const venueId = uuidv4();
    const slug = name.toLowerCase().replace(/[^a-z0-9а-яё\s]/g, '').trim().replace(/\s+/g, '-');

    // Создаём заведение с временным qr_code
    const venue = new Venue({
      name,
      address,
      hours,
      photo_url: photo_url || undefined,
      qr_code: 'tmp_' + Date.now(),
      ownerUserId: owner._id,
    });
    await venue.save();

    // Теперь обновляем qr_code с реальным _id
    venue.qr_code = `SOPL_venue_${slug}_${venue._id}`;
    await venue.save();

    // Обновляем юзера: роль venue_admin + ссылка на заведение
    owner.role = 'venue_admin';
    owner.venue_id = venue._id;
    await owner.save();

    res.status(201).json({
      ...venue.toObject(),
      ownerUser: { _id: owner._id, username: owner.username, email: owner.email },
    });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка создания заведения: ' + error.message });
  }
});
app.delete('/api/admin/venues/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    
    console.log('🗑️ Deleting venue:', venueId);

    // Находим заведение
    const venue = await Venue.findById(venueId);
    
    if (!venue) {
      return res.status(404).json({ message: 'Заведение не найдено' });
    }

    // Удаляем все связанные данные
    await Queue.deleteMany({ venue_id: venueId });
    
    // Обновляем владельца (убираем роль venue_admin если это его единственное заведение)
    if (venue.ownerUserId) {
      const otherVenues = await Venue.countDocuments({ 
        ownerUserId: venue.ownerUserId, 
        _id: { $ne: venueId } 
      });
      
      if (otherVenues === 0) {
        await User.findByIdAndUpdate(venue.ownerUserId, {
          role: 'user',
          venue_id: null
        });
      }
    }

    // Удаляем само заведение
    await Venue.findByIdAndDelete(venueId);

    console.log('✅ Venue deleted successfully');
    res.json({ message: 'Заведение удалено' });

  } catch (error) {
    console.error('❌ Error deleting venue:', error);
    res.status(500).json({ message: 'Ошибка удаления заведения: ' + error.message });
  }
});
app.post('/api/admin/venues/upload-banner', authMiddleware, adminMiddleware, upload.single('banner'), async (req, res) => {
  try {
    const bannerFile = req.file;
    
    if (!bannerFile) {
      return res.status(400).json({ message: 'Файл баннера не загружен' });
    }

    // Multer-S3 автоматически загружает в папку banners/ (см. ниже)
    // и возвращает location (полный URL файла)
    res.json({ 
      url: bannerFile.location,
      message: 'Баннер успешно загружен'
    });
    
  } catch (error) {
    console.error('Ошибка загрузки баннера:', error);
    res.status(500).json({ message: 'Ошибка загрузки баннера: ' + error.message });
  }
});
app.get('/api/admin/venues', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const venues = await Venue.find().sort({ createdAt: -1 });

    // Для каждого заведения подтянем юзера-владельца по ownerUserId
    const result = await Promise.all(
      venues.map(async (v) => {
        let ownerUser = null;
        if (v.ownerUserId) {
          ownerUser = await User.findById(v.ownerUserId).select('username email');
        }
        return { ...v.toObject(), ownerUser };
      })
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки заведений' });
  }
});
// 3. ОБНОВИ ЭНДПОИНТ СОЗДАНИЯ ЗАВЕДЕНИЯ (замени существующий)
app.post('/api/admin/venues', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, ownerEmail, address, hours, photo_url } = req.body;

    if (!name) return res.status(400).json({ message: 'Название обязательно' });
    if (!ownerEmail) return res.status(400).json({ message: 'Email владельца обязателен' });

    const owner = await User.findOne({ email: ownerEmail });
    if (!owner) {
      return res.status(404).json({ message: `Пользователь с email "${ownerEmail}" не найден` });
    }

    const venue = new Venue({
      name,
      address,
      hours,
      photo_url: photo_url || undefined, // 🔥 Теперь это будет URL из S3
      qr_code: 'tmp',
      ownerUserId: owner._id,
    });
    await venue.save();

    const slug = name.toLowerCase().replace(/[^a-z0-9а-яё\s]/g, '').trim().replace(/\s+/g, '-');
    venue.qr_code = `SOPL_venue_${slug}_${venue._id}`;
    await venue.save();

    owner.role = 'venue_admin';
    owner.venue_id = venue._id;
    await owner.save();

    res.status(201).json({
      ...venue.toObject(),
      ownerUser: { _id: owner._id, username: owner.username, email: owner.email },
    });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка создания заведения: ' + error.message });
  }
});
// Статистика для админки
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const stats = {
      totalUsers: await User.countDocuments(),
      totalTracks: await Track.countDocuments({ isApproved: true }),
      pendingTracks: await Track.countDocuments({ isApproved: false }),
      totalVenues: await Venue.countDocuments(),
      activeQueues: await Queue.countDocuments({ status: 'pending' })
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки статистики' });
  }
});

// ============================================
// 🔥 СПЕЦИАЛЬНЫЙ ЭНДПОИНТ ДЛЯ ПЕРВИЧНОЙ НАСТРОЙКИ
// ============================================
app.get('/api/users/:id/online-status', authMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    const isOnline = onlineUsers.has(userId);
    
    res.json({ isOnline });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка' });
  }
});
app.get('/api/artists/list', async (req, res) => {
  try {
    const artists = await User.find({ 
      role: 'artist' 
    }).select('_id username avatar_url stats artistInfo');
    
    res.json(artists);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки артистов' });
  }
});
app.get('/api/setup/make-admin', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).send(`
        <h1>❌ Укажи email</h1>
        <p>Использование: /api/setup/make-admin?email=твой@email.com</p>
      `);
    }

    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(404).send(`
        <h1>❌ Пользователь не найден</h1>
        <p>Пользователь с email <b>${email}</b> не существует.</p>
        <p>Сначала зарегистрируйся в приложении!</p>
      `);
    }

    user.role = 'super_admin';
    await user.save();

    res.send(`
      <h1>✅ Готово!</h1>
      <p>Пользователь <b>${user.username}</b> (${user.email}) теперь <b>СУПЕР-АДМИН</b>!</p>
      <p>Теперь ты можешь:</p>
      <ul>
        <li>Управлять треками на модерацию</li>
        <li>Назначать других админов</li>
        <li>Создавать заведения</li>
      </ul>
    `);
  } catch (error) {
    res.status(500).send('Ошибка: ' + error.message);
  }
});
app.get('/api/users/:id/followers', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('followers', 'username avatar_url stats');
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
    res.json(user.followers || []);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// Получить подписки
app.get('/api/users/:id/following', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('following', 'username avatar_url stats');
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
    res.json(user.following || []);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// ПОДПИСАТЬСЯ / ОТПИСАТЬСЯ
app.post('/api/users/follow/:id', authMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user._id.toString();

    if (targetUserId === currentUserId) {
      return res.status(400).json({ message: 'Нельзя подписаться на себя' });
    }

    const currentUser = await User.findById(currentUserId);
    const targetUser = await User.findById(targetUserId);

    if (!targetUser) return res.status(404).json({ message: 'Пользователь не найден' });

    const isFollowing = currentUser.following.includes(targetUserId);

    if (isFollowing) {
      // ОТПИСКА
      currentUser.following.pull(targetUserId);
      targetUser.followers.pull(currentUserId);
      
      currentUser.stats.following = Math.max(0, currentUser.stats.following - 1);
      targetUser.stats.followers = Math.max(0, targetUser.stats.followers - 1);
    } else {
      // ПОДПИСКА
      currentUser.following.push(targetUserId);
      targetUser.followers.push(currentUserId);
      
      currentUser.stats.following += 1;
      targetUser.stats.followers += 1;

      // 🔔 СОЗДАЁМ УВЕДОМЛЕНИЕ
      await createNotification(
        targetUserId,
        currentUserId,
        'follow',
        `подписался на вас`
      );
    }

    await currentUser.save();
    await targetUser.save();

    res.json({ 
      message: isFollowing ? 'Отписка успешна' : 'Подписка успешна',
      isFollowing: !isFollowing 
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Ошибка при подписке' });
  }
});
app.get('/api/users/me/liked-tracks', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('likedTracks');
    res.json(user.likedTracks || []);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки избранного' });
  }
});
app.get('/api/users/:id/liked-tracks', async (req, res) => {
  try {
    const userId = req.params.id;
    
    console.log('📥 Fetching liked tracks for user:', userId);
    
    const user = await User.findById(userId).populate('likedTracks');
    
    if (!user) {
      return res.status(404).json({ message: 'Пользователь не найден' });
    }
    
    console.log('✅ Found', user.likedTracks?.length || 0, 'liked tracks');
    
    res.json(user.likedTracks || []);
  } catch (error) {
    console.error('❌ Error fetching liked tracks:', error);
    res.status(500).json({ message: 'Ошибка загрузки избранного' });
  }
});

app.get('/api/playlists', authMiddleware, async (req, res) => {
  try {
    // 1. Проверяем, дошел ли запрос вообще
    console.log('📡 GET /api/playlists: Запрос получен!');
    console.log('👤 Пользователь:', req.user.username, 'ID:', req.user._id);

    const playlists = await Playlist.find({ owner_id: req.user._id })
      .populate('tracks')
      .sort({ updatedAt: -1 });
    
    // 2. Проверяем, что нашла база данных
    console.log('📂 Найдено плейлистов в БД:', playlists.length);

    res.json(playlists);
  } catch (error) {
    console.error('❌ Ошибка /api/playlists:', error);
    res.status(500).json({ message: 'Ошибка загрузки плейлистов' });
  }
});


// ─── Создать плейлист ──────────────────────────────────
app.post('/api/playlists', authMiddleware, upload.single('cover'), async (req, res) => {
  try {
    const { name, description, isPublic } = req.body;

    console.log('📝 Creating playlist:', { name, description, isPublic });

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Название обязательно' });
    }

    const playlist = new Playlist({
      name: name.trim(),
      description: description?.trim() || '',
      cover: req.file ? req.file.location : undefined,
      owner_id: req.user._id,
      tracks: [],
      isPublic: isPublic === 'true',
    });

    await playlist.save();
    
    console.log('✅ Playlist created:', playlist._id);

    // Создаём событие в ленте
    const newActivity = new FeedActivity({
      type: 'playlist_add',
      user_id: req.user._id,
      playlist_name: playlist.name,
      timestamp: new Date()
    });
    await newActivity.save();

    // Обновляем счетчик плейлистов
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { 'stats.playlists': 1 },
    });

    res.status(201).json(playlist);
  } catch (error) {
    console.error('❌ Error creating playlist:', error);
    res.status(500).json({ message: 'Ошибка создания плейлиста: ' + error.message });
  }
});
app.put('/api/playlists/:id', authMiddleware, upload.single('cover'), async (req, res) => {
  try {
    const { name, description, isPublic } = req.body;
    const playlistId = req.params.id;

    console.log('📝 Updating playlist:', playlistId);

    const playlist = await Playlist.findById(playlistId);

    if (!playlist) {
      return res.status(404).json({ message: 'Плейлист не найден' });
    }

    if (playlist.owner_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Нет доступа' });
    }

    const updates = {};
    if (name) updates.name = name.trim();
    if (description !== undefined) updates.description = description.trim();
    if (isPublic !== undefined) updates.isPublic = isPublic === 'true';
    if (req.file) updates.cover = req.file.location;
    
    updates.updatedAt = new Date();

    const updated = await Playlist.findByIdAndUpdate(
      playlistId,
      updates,
      { new: true }
    );

    console.log('✅ Playlist updated');
    res.json(updated);

  } catch (error) {
    console.error('❌ Error updating playlist:', error);
    res.status(500).json({ message: 'Ошибка обновления плейлиста: ' + error.message });
  }
});
const NotificationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  from_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { 
    type: String, 
    enum: ['follow', 'like', 'comment', 'playlist_add', 'new_track', 'liked_track', 'message'], 
    required: true 
  },
  track_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Track' },
  playlist_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist' }, // ✅ Уже есть
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  chat_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectChat' },
  createdAt: { type: Date, default: Date.now }
});

const Notification = mongoose.model('Notification', NotificationSchema);
const ChatMessageSchema = new mongoose.Schema({
  trackId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Track', required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:        { type: String, required: true, maxlength: 500 },
  createdAt:   { type: Date, default: Date.now }
});

ChatMessageSchema.index({ trackId: 1, createdAt: -1 });

const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);
const DirectChatSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastMessage: {
    text: String,
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now }
  },
  unreadCount: {
    type: Map,
    of: Number,
    default: {}
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

DirectChatSchema.index({ participants: 1 });
const DirectChat = mongoose.model('DirectChat', DirectChatSchema);

const DirectMessageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectChat', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 1000 },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

DirectMessageSchema.index({ chatId: 1, createdAt: -1 });
const DirectMessage = mongoose.model('DirectMessage', DirectMessageSchema);
// ============================================
// 2. ЭНДПОИНТЫ УВЕДОМЛЕНИЙ
// ============================================

// Получить уведомления текущего пользователя
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await Notification.find({ user_id: req.user._id })
      .populate('from_user_id', 'username avatar_url isVerified')
      .populate('track_id', 'title artist cover')
      .populate('playlist_id', 'name') // 🔥 ДОБАВИЛИ
      .sort({ createdAt: -1 })
      .limit(50);

    const formatted = notifications.map(notif => ({
      _id: notif._id,
      type: notif.type,
      user: {
        _id: notif.from_user_id?._id,
        username: notif.from_user_id?.username,
        avatar_url: notif.from_user_id?.avatar_url,
        isVerified: notif.from_user_id?.isVerified
      },
      track: notif.track_id ? {
        _id: notif.track_id._id,
        title: notif.track_id.title,
        artist: notif.track_id.artist,
        cover: notif.track_id.cover
      } : undefined,
      playlist: notif.playlist_id ? { // 🔥 ДОБАВИЛИ
        _id: notif.playlist_id._id,
        name: notif.playlist_id.name
      } : undefined,
      message: notif.message,
      read: notif.read,
      createdAt: notif.createdAt
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Ошибка загрузки уведомлений' });
  }
});

// Отметить уведомление как прочитанное
app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user._id },
      { read: true },
      { new: true }
    );

    if (!notif) {
      return res.status(404).json({ message: 'Уведомление не найдено' });
    }

    res.json({ message: 'Отмечено как прочитанное' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления' });
  }
});

// Отметить все уведомления как прочитанные
app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany(
      { user_id: req.user._id, read: false },
      { read: true }
    );

    res.json({ message: 'Все уведомления отмечены как прочитанные' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка обновления' });
  }
});
async function createNotification(userId, fromUserId, type, message, trackId = null, playlistId = null, chatId = null) {
  try {
    const notification = new Notification({
      user_id: userId,
      from_user_id: fromUserId,
      type,
      message,
      track_id: trackId,
      playlist_id: playlistId,
      chat_id: chatId // 🔥 ДОБАВИЛИ поле chatId
    });

    await notification.save();
    console.log(`✅ Создано уведомление для пользователя ${userId}`);

    // WebSocket broadcast
    const userConnections = new Map(); // userId -> Set<WebSocket>

function broadcastToUser(userId, payload) {
  const connections = userConnections.get(userId);
  if (!connections) return;
  
  const str = JSON.stringify(payload);
  connections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(str);
    }
  });
}
  } catch (error) {
    console.error('Ошибка создания уведомления:', error);
  }
}
// ─── Получить плейлист по ID (публичный) ───────────────
app.get('/api/playlists/:id', async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.id)
      .populate('tracks')
      .populate('owner_id', 'username avatar_url'); // ✅ ДОБАВИЛИ populate

    if (!playlist) {
      return res.status(404).json({ message: 'Плейлист не найден' });
    }

    console.log('✅ Playlist loaded:', playlist._id);
    res.json(playlist);
    
  } catch (error) {
    console.error('❌ Error loading playlist:', error);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});


app.post('/api/playlists/:id/tracks', authMiddleware, async (req, res) => {
  try {
    const { trackId } = req.body;
    const playlistId = req.params.id;

    console.log('📝 Adding track to playlist:', { playlistId, trackId });

    if (!trackId) {
      return res.status(400).json({ message: 'trackId обязателен' });
    }

    const playlist = await Playlist.findById(playlistId);
    if (!playlist) {
      return res.status(404).json({ message: 'Плейлист не найден' });
    }

    if (playlist.owner_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Нет доступа к этому плейлисту' });
    }

    const track = await Track.findById(trackId);
    if (!track) {
      return res.status(404).json({ message: 'Трек не найден' });
    }

    if (playlist.tracks.includes(trackId)) {
      return res.status(400).json({ message: 'Трек уже в плейлисте' });
    }

    playlist.tracks.push(trackId);
    playlist.updatedAt = new Date();
    await playlist.save();

    console.log('✅ Track added to playlist');

    // 🔥 ИСПРАВЛЕНО: Создаём активность С track_id
    const newActivity = new FeedActivity({
      type: 'playlist_add',
      user_id: req.user._id,
      track_id: trackId, // 🔥 ЭТО ВАЖНО!
      playlist_name: playlist.name,
      timestamp: new Date()
    });
    await newActivity.save();

    // Отправляем уведомления подписчикам
    const user = await User.findById(req.user._id);
    if (user && user.followers && user.followers.length > 0) {
      for (const followerId of user.followers) {
        await createNotification(
          followerId,
          req.user._id,
          'playlist_add',
          `добавил трек "${track.title}" в плейлист "${playlist.name}"`,
          trackId,
          playlistId
        );
      }
      console.log(`✅ Отправлено ${user.followers.length} уведомлений о добавлении в плейлист`);
    }

    const updatedPlaylist = await Playlist.findById(playlistId)
      .populate('tracks')
      .populate('owner_id', 'username avatar_url');

    res.json(updatedPlaylist);

  } catch (error) {
    console.error('❌ Error adding track to playlist:', error);
    res.status(500).json({ message: 'Ошибка добавления трека: ' + error.message });
  }
});


// ─── Удалить трек из плейлиста ─────────────────────────
app.delete('/api/playlists/:id/tracks/:trackId', authMiddleware, async (req, res) => {
  try {
    const { id: playlistId, trackId } = req.params;

    console.log('🗑️ Removing track from playlist:', { playlistId, trackId });

    const playlist = await Playlist.findById(playlistId);
    if (!playlist) {
      return res.status(404).json({ message: 'Плейлист не найден' });
    }

    if (playlist.owner_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Нет доступа' });
    }

    // Удаляем трек
    playlist.tracks = playlist.tracks.filter(t => t.toString() !== trackId);
    playlist.updatedAt = new Date();
    await playlist.save();

    console.log('✅ Track removed from playlist');

    const updatedPlaylist = await Playlist.findById(playlistId)
      .populate('tracks')
      .populate('owner_id', 'username avatar_url');

    res.json(updatedPlaylist);

  } catch (error) {
    console.error('❌ Error removing track:', error);
    res.status(500).json({ message: 'Ошибка удаления трека: ' + error.message });
  }
});



// ─── Удалить плейлист целиком ──────────────────────────
app.delete('/api/playlists/:id', authMiddleware, async (req, res) => {
  try {
    const playlist = await Playlist.findById(req.params.id);

    if (!playlist) return res.status(404).json({ message: 'Плейлист не найден' });
    if (playlist.owner_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Нет доступа' });
    }

    await Playlist.findByIdAndDelete(req.params.id);
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { 'stats.playlists': -1 },
    });

    res.json({ message: 'Плейлист удалён' });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка удаления плейлиста' });
  }
});
app.get('/api/users/:id/playlists', async (req, res) => {
  try {
    const playlists = await Playlist.find({
      owner_id: req.params.id,
      isPublic: true,
    })
      .populate('tracks')
      .sort({ updatedAt: -1 });

    res.json(playlists);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки плейлистов' });
  }
});
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id.toString(); // Приводим к строке сразу

    const chats = await DirectChat.find({
      participants: req.user._id
    })
      .populate('participants', 'username avatar_url')
      .populate('lastMessage.sender', 'username')
      .sort({ 'lastMessage.timestamp': -1 });

    const formatted = chats.map(chat => {
      // 1. Фильтруем участников, исключая null (удаленных пользователей)
      const validParticipants = (chat.participants || []).filter(p => p != null);

      // 2. Ищем собеседника
      let otherUser = validParticipants.find(p => p._id.toString() !== userId);

      // 3. Если собеседник не найден (удален), ставим заглушку
      if (!otherUser) {
        otherUser = {
          _id: 'deleted',
          username: 'Удаленный аккаунт',
          avatar_url: null
        };
      }

      // 4. Безопасное получение счетчика непрочитанных
      const unreadCount = (chat.unreadCount && chat.unreadCount.get(userId)) || 0;

      // 5. Обработка последнего сообщения (проверка на null)
      let lastMessage = null;
      if (chat.lastMessage && chat.lastMessage.text) {
          // Проверяем, существует ли sender (он мог быть удален)
          const senderId = chat.lastMessage.sender ? chat.lastMessage.sender.toString() : null;
          lastMessage = {
            text: chat.lastMessage.text,
            sender: chat.lastMessage.sender,
            timestamp: chat.lastMessage.timestamp,
            isOwn: senderId === userId
          };
      }

      return {
        _id: chat._id,
        participant: {
          _id: otherUser._id,
          username: otherUser.username,
          avatar_url: otherUser.avatar_url
        },
        lastMessage,
        unreadCount,
        updatedAt: chat.updatedAt
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ message: 'Ошибка загрузки чатов' });
  }
});
app.post('/api/chats/create', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const currentUserId = req.user._id;

    if (!userId) {
      return res.status(400).json({ message: 'userId обязателен' });
    }

    if (userId === currentUserId.toString()) {
      return res.status(400).json({ message: 'Нельзя создать чат с самим собой' });
    }

    // Проверяем, существует ли уже чат
    let chat = await DirectChat.findOne({
      participants: { $all: [currentUserId, userId] }
    }).populate('participants', 'username avatar_url');

    if (!chat) {
      // Создаём новый чат
      chat = new DirectChat({
        participants: [currentUserId, userId],
        unreadCount: new Map()
      });
      await chat.save();
      await chat.populate('participants', 'username avatar_url');
    }

    const otherUser = chat.participants.find(p => p._id.toString() !== currentUserId.toString());

    res.json({
      _id: chat._id,
      participant: {
        _id: otherUser._id,
        username: otherUser.username,
        avatar_url: otherUser.avatar_url
      },
      lastMessage: chat.lastMessage || null,
      unreadCount: chat.unreadCount.get(currentUserId.toString()) || 0
    });
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ message: 'Ошибка создания чата' });
  }
});
app.get('/api/notifications/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      user_id: req.user._id,
      read: false
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка' });
  }
});
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user._id;

    // Проверяем доступ к чату
    const chat = await DirectChat.findById(chatId);
    if (!chat || !chat.participants.includes(userId)) {
      return res.status(403).json({ message: 'Нет доступа к этому чату' });
    }

    const messages = await DirectMessage.find({ chatId })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate('sender', 'username avatar_url');

    // Отмечаем все сообщения как прочитанные
    await DirectMessage.updateMany(
      { chatId, sender: { $ne: userId }, read: false },
      { read: true }
    );

    // Обнуляем счётчик непрочитанных
    chat.unreadCount.set(userId.toString(), 0);
    await chat.save();

    res.json(messages.map(msg => ({
      _id: msg._id,
      sender: {
        _id: msg.sender._id,
        username: msg.sender.username,
        avatar_url: msg.sender.avatar_url
      },
      text: msg.text,
      read: msg.read,
      isOwn: msg.sender._id.toString() === userId.toString(),
      createdAt: msg.createdAt
    })));
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ message: 'Ошибка загрузки сообщений' });
  }
});

// Отправить сообщение (REST fallback, основной способ - через WebSocket)
app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text } = req.body;
    const userId = req.user._id;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Текст сообщения обязателен' });
    }

    const chat = await DirectChat.findById(chatId).populate('participants', 'username avatar_url');
    if (!chat || !chat.participants.some(p => p._id.toString() === userId.toString())) {
      return res.status(403).json({ message: 'Нет доступа к этому чату' });
    }

    const message = new DirectMessage({
      chatId,
      sender: userId,
      text: text.trim()
    });
    await message.save();

    // Обновляем lastMessage в чате
    chat.lastMessage = {
      text: text.trim(),
      sender: userId,
      timestamp: new Date()
    };
    chat.updatedAt = new Date();

    // Увеличиваем счётчик непрочитанных для другого пользователя
    const otherUser = chat.participants.find(p => p._id.toString() !== userId.toString());
    const currentCount = chat.unreadCount.get(otherUser._id.toString()) || 0;
    chat.unreadCount.set(otherUser._id.toString(), currentCount + 1);

    await chat.save();

    // Создаём уведомление для получателя
    await createNotification(
      otherUser._id,
      userId,
      'message',
      `отправил вам сообщение: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
      null,
      null,
      chatId
    );

    // WebSocket broadcast (если пользователь онлайн)
    broadcastToUser(otherUser._id.toString(), {
      type: 'new_message',
      chatId,
      message: {
        _id: message._id,
        sender: {
          _id: userId,
          username: req.user.username,
          avatar_url: req.user.avatar_url
        },
        text: message.text,
        createdAt: message.createdAt
      }
    });

    res.status(201).json({
      _id: message._id,
      sender: {
        _id: userId,
        username: req.user.username,
        avatar_url: req.user.avatar_url
      },
      text: message.text,
      isOwn: true,
      createdAt: message.createdAt
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ message: 'Ошибка отправки сообщения' });
  }
});

// Получить общее количество непрочитанных сообщений
app.get('/api/chats/unread-count', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id.toString();

    const chats = await DirectChat.find({
      participants: userId
    });

    let totalUnread = 0;
    chats.forEach(chat => {
      totalUnread += chat.unreadCount.get(userId) || 0;
    });

    res.json({ count: totalUnread });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ message: 'Ошибка' });
  }
});

// Недавняя активность пользователя (из FeedActivity)
app.get('/api/users/:id/activity', async (req, res) => {
  try {
    const activities = await FeedActivity.find({ user_id: req.params.id })
      .populate('track_id')
      .populate('venue_id', 'name')
      .sort({ timestamp: -1 })
      .limit(10);

    res.json(
      activities.map((a) => ({
        _id:       a._id,
        type:      a.type,
        track:     a.track_id,
        venue:     a.venue_id,
        isLive:    a.isLive,
        timestamp: a.timestamp,
      }))
    );
  } catch (error) {
    res.status(500).json({ message: 'Ошибка загрузки активности' });
  }
});
app.get('/api/users/search', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: 'Укажи email' });

    const user = await User.findOne({ email }).select('-password');
    if (!user) return res.status(404).json({ message: 'Не найден' });

    res.json({ _id: user._id, username: user.username, email: user.email, role: user.role });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка поиска' });
  }
});
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

app.get('/api/tracks/:id/chat', async (req, res) => {
  try {
    const messages = await ChatMessage.find({ trackId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(60)
      .populate('userId', 'username avatar_url');

    const formatted = messages.reverse().map((m) => ({
      id:          m._id.toString(),
      userId:     m.userId._id.toString(),
      displayName: m.userId.username,
      avatar:      m.userId.avatar_url || undefined,
      text:        m.text,
      createdAt:   m.createdAt.getTime(),
    }));

    res.json(formatted);
  } catch (error) {
    console.error('❌ Chat history error:', error);
    res.status(500).json({ message: 'Ошибка загрузки чата' });
  }
});

// Отправить сообщение через REST (fallback)
app.post('/api/tracks/:id/chat', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim() || text.trim().length > 500) {
      return res.status(400).json({ message: 'Текст некорректен' });
    }

    const msg = new ChatMessage({
      trackId: req.params.id,
      userId: req.user._id,
      text:    text.trim(),
    });
    await msg.save();

    const formatted = {
      id:          msg._id.toString(),
      userId:     req.user._id.toString(),
      displayName: req.user.username,
      avatar:      req.user.avatar_url || undefined,
      text:        msg.text,
      createdAt:   msg.createdAt.getTime(),
    };

    // Даже при REST-отправке бродкастим через WS
    broadcastToTrack(req.params.id, { type: 'message', data: formatted });

    res.status(201).json(formatted);
  } catch (error) {
    console.error('❌ Chat send error:', error);
    res.status(500).json({ message: 'Ошибка отправки' });
  }
});

// Количество слушателей прямо сейчас
app.get('/api/tracks/:id/listeners', async (req, res) => {
  try {
    const room = chatRooms.get(req.params.id);
    res.json({ count: room ? room.size : 0 });
  } catch (error) {
    res.status(500).json({ message: 'Ошибка' });
  }
});

// === ГЛАВНАЯ ===
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 SOPL Backend</h1>
    <p>Сервер работает!</p>
  `);
});

// === ЗАПУСК ===
const PORT = process.env.PORT || 5000;

// ============================================
// ЗАПУСК И WEBSOCKET (ИСПРАВЛЕНО)
// ============================================

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/sopl')
  .then(() => {
    console.log('✅ База данных подключена');

    // Запускаем HTTP сервер
    const server = app.listen(PORT, () => {
      console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
      console.log(`🔌 WebSocket готов на ws://localhost:${PORT}`);
    });

    // Навешиваем WebSocket на тот же сервер
    const wss = new WebSocket.Server({ server });
    
    
app.get('/api/debug/check-user-venue', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    console.log('=== DEBUG: Проверка пользователя ===');
    console.log('User ID:', user._id);
    console.log('Username:', user.username);
    console.log('Email:', user.email);
    console.log('Role:', user.role);
    console.log('venue_id:', user.venue_id);
    
    let venue = null;
    let venueExists = false;
    
    if (user.venue_id) {
      venue = await Venue.findById(user.venue_id);
      venueExists = !!venue;
      
      if (venue) {
        console.log('✅ Заведение найдено:', venue.name);
        console.log('Venue ID:', venue._id);
        console.log('Owner User ID:', venue.ownerUserId);
      } else {
        console.log('❌ Заведение с ID', user.venue_id, 'не существует в базе');
      }
    } else {
      console.log('⚠️ У пользователя нет venue_id');
    }
    
    // Ищем все заведения, где этот пользователь - владелец
    const ownedVenues = await Venue.find({ ownerUserId: user._id });
    console.log('Заведения, где пользователь - owner:', ownedVenues.length);
    
    if (ownedVenues.length > 0) {
      console.log('Список заведений владельца:');
      ownedVenues.forEach(v => {
        console.log(`  - ${v.name} (ID: ${v._id})`);
      });
    }
    
    // Формируем ответ
    const response = {
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        venue_id: user.venue_id?.toString() || null
      },
      assignedVenue: venue ? {
        _id: venue._id,
        name: venue.name,
        exists: true
      } : {
        exists: false,
        message: user.venue_id ? 'Заведение не найдено в базе' : 'venue_id не назначен'
      },
      ownedVenues: ownedVenues.map(v => ({
        _id: v._id,
        name: v.name
      })),
      recommendation: null
    };
    
    // Рекомендация по исправлению
    if (user.role === 'venue_admin') {
      if (!user.venue_id && ownedVenues.length > 0) {
        response.recommendation = `Назначить venue_id = ${ownedVenues[0]._id}`;
      } else if (user.venue_id && !venueExists && ownedVenues.length > 0) {
        response.recommendation = `Исправить venue_id на ${ownedVenues[0]._id}`;
      } else if (!venueExists && ownedVenues.length === 0) {
        response.recommendation = 'Создать новое заведение или назначить существующее';
      }
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// СКРИПТ ДЛЯ АВТОМАТИЧЕСКОГО ИСПРАВЛЕНИЯ
// ============================================

app.post('/api/debug/fix-user-venue', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (user.role !== 'venue_admin') {
      return res.status(400).json({ 
        message: 'Пользователь не является venue_admin' 
      });
    }
    
    // Ищем заведения, где пользователь - владелец
    const ownedVenues = await Venue.find({ ownerUserId: user._id });
    
    if (ownedVenues.length === 0) {
      return res.status(404).json({ 
        message: 'У пользователя нет заведений. Создайте заведение через админ-панель.' 
      });
    }
    
    // Назначаем первое найденное заведение
    const venue = ownedVenues[0];
    user.venue_id = venue._id;
    await user.save();
    
    res.json({ 
      message: 'Исправлено!',
      user: {
        _id: user._id,
        username: user.username,
        venue_id: user.venue_id
      },
      venue: {
        _id: venue._id,
        name: venue.name
      }
    });
    
  } catch (error) {
    console.error('Fix error:', error);
    res.status(500).json({ message: error.message });
  }
});

    wss.on('connection', (ws) => {
      // ── venue (существующее) ──
      ws.venueId = null;
      wsClients.add(ws);

      // ── chat (новое) ──
      ws.chatTrackId = null;
      ws.chatUserId  = null;
      ws.chatUser    = null;   // { username, avatar_url }

     ws.on('message', async (raw) => {
  try {
    const msg = JSON.parse(raw);

    // Подписка на venue (НОВОЕ!)
    if (msg.type === 'subscribe_venue' && msg.venueId) {
      ws.venueId = msg.venueId;
      console.log(`[WS] Client subscribed to venue: ${msg.venueId}`);
      ws.send(JSON.stringify({ 
        type: 'subscribed', 
        venueId: msg.venueId 
      }));
      return;
    }
          if (msg.type === 'auth' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, process.env.JWT_SECRET || 'secret_key_change_this');
          ws.userId = decoded.id;
          
          // 🔥 ДОБАВЛЯЕМ В ОНЛАЙН
          if (!onlineUsers.has(ws.userId)) {
            onlineUsers.set(ws.userId, new Set());
          }
          onlineUsers.get(ws.userId).add(ws);
          
          // 🔥 УВЕДОМЛЯЕМ ВСЕ ЧАТЫ ПОЛЬЗОВАТЕЛЯ О СТАТУСЕ "ОНЛАЙН"
          broadcastUserStatus(ws.userId, true);
          
          ws.send(JSON.stringify({ type: 'auth_success', userId: ws.userId }));
          console.log(`[WS] User ${ws.userId} authenticated and online`);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
        }
        return;
      }
      if (msg.type === 'typing' && ws.userId && msg.chatId) {
        const chatId = msg.chatId;
        const isTyping = msg.isTyping;
        
        // Находим чат
        const chat = await DirectChat.findById(chatId);
        if (!chat || !chat.participants.includes(ws.userId)) {
          return;
        }
        
        // Находим собеседника
        const otherUser = chat.participants.find(p => p.toString() !== ws.userId);
        if (!otherUser) return;
        
        // Отправляем статус "печатает" собеседнику
        const otherUserConnections = onlineUsers.get(otherUser.toString());
        if (otherUserConnections) {
          otherUserConnections.forEach(connection => {
            if (connection.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify({ 
                type: 'user_typing', 
                userId: ws.userId,
                chatId,
                isTyping 
              }));
            }
          });
        }
        
        console.log(`[WS] User ${ws.userId} ${isTyping ? 'is typing' : 'stopped typing'} in chat ${chatId}`);
        return;
      }
           if (msg.type === 'send_message' && ws.userId) {
        const { chatId, text } = msg;
        
        if (!chatId || !text) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing chatId or text' }));
          return;
        }

        const chat = await DirectChat.findById(chatId);
        if (!chat || !chat.participants.some(p => p.toString() === ws.userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
          return;
        }

        const message = new DirectMessage({
          chatId,
          sender: ws.userId,
          text: text.trim()
        });
        await message.save();

        const sender = await User.findById(ws.userId).select('username avatar_url');
        
        chat.lastMessage = {
          text: text.trim(),
          sender: ws.userId,
          timestamp: new Date()
        };
        chat.updatedAt = new Date();

        const otherUser = chat.participants.find(p => p.toString() !== ws.userId);
        const currentCount = chat.unreadCount.get(otherUser.toString()) || 0;
        chat.unreadCount.set(otherUser.toString(), currentCount + 1);

        await chat.save();

        const payload = {
          _id: message._id,
          sender: {
            _id: sender._id,
            username: sender.username,
            avatar_url: sender.avatar_url
          },
          text: message.text,
          createdAt: message.createdAt,
          isOwn: true
        };

        ws.send(JSON.stringify({ type: 'message_sent', message: payload }));

        // Отправляем получателю
        const otherUserConnections = onlineUsers.get(otherUser.toString());
        if (otherUserConnections) {
          otherUserConnections.forEach(connection => {
            if (connection.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify({
                type: 'new_message',
                chatId,
                message: { ...payload, isOwn: false }
              }));
            }
          });
        }

        console.log(`[WS] Message sent in chat ${chatId}`);
        return;
      }

          // 3. Подписка на чат трека (Chat Subscribe)
          if (msg.type === 'chat_subscribe' && msg.trackId) {
            const trackId = msg.trackId;

            // Если уже в другой комнате — выход
            if (ws.chatTrackId && ws.chatTrackId !== trackId) {
              const oldRoom = chatRooms.get(ws.chatTrackId);
              if (oldRoom) {
                oldRoom.delete(ws);
                if (oldRoom.size === 0) chatRooms.delete(ws.chatTrackId);
                else sendListenersUpdate(ws.chatTrackId);
              }
            }

            ws.chatTrackId = trackId;

            // Авторизация по токену (опционально внутри чата)
            if (msg.token) {
              try {
                const decoded = jwt.verify(msg.token, process.env.JWT_SECRET || 'secret_key_change_this');
                const user = await User.findById(decoded.id).select('username avatar_url');
                if (user) {
                  ws.chatUserId = user._id.toString();
                  ws.chatUser   = { username: user.username, avatar_url: user.avatar_url };
                }
              } catch (e) {
                console.log('[Chat] invalid token');
              }
            }

            // Добавляем в комнату
            if (!chatRooms.has(trackId)) chatRooms.set(trackId, new Set());
            chatRooms.get(trackId).add(ws);

            // Обновление слушателей для всех в комнате
            sendListenersUpdate(trackId);

            ws.send(JSON.stringify({ type: 'chat_subscribed', trackId }));
            console.log(`[Chat] ${ws.chatUserId || 'anon'} → joined ${trackId} (в комнате: ${chatRooms.get(trackId).size})`);
            return;
          }
 if (msg.type === 'chat_subscribe' && msg.chatId) {
        ws.chatId = msg.chatId;
        
        // Проверяем, имеет ли пользователь доступ к чату
        if (ws.userId) {
          const chat = await DirectChat.findById(msg.chatId);
          if (chat && chat.participants.includes(ws.userId)) {
            ws.send(JSON.stringify({ type: 'chat_subscribed', chatId: msg.chatId }));
            console.log(`[WS] User ${ws.userId} subscribed to chat ${msg.chatId}`);
            
            // 🔥 ОТПРАВЛЯЕМ СТАТУС СОБЕСЕДНИКА (ОНЛАЙН ИЛИ НЕТ)
            const otherUser = chat.participants.find(p => p.toString() !== ws.userId);
            if (otherUser) {
              const isOnline = onlineUsers.has(otherUser.toString());
              ws.send(JSON.stringify({ 
                type: 'user_status', 
                userId: otherUser.toString(),
                isOnline 
              }));
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Access denied to this chat' }));
          }
        }
        return;
      }
          // 4. Сообщение в чат трека (Track Message)
          if (msg.type === 'message' && msg.text && ws.chatTrackId) {
            if (!ws.chatUserId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Авторизуйся' }));
              return;
            }

            const text = msg.text.trim();
            if (!text || text.length > 500) return;

            // Сохраняем в БД
            const chatMsg = new ChatMessage({
              trackId: ws.chatTrackId,
              userId: ws.chatUserId,
              text,
            });
            await chatMsg.save();

            const payload = {
              id:          chatMsg._id.toString(),
              userId:      ws.chatUserId,
              displayName: ws.chatUser.username,
              avatar:      ws.chatUser.avatar_url || undefined,
              text:        chatMsg.text,
              createdAt:   chatMsg.createdAt.getTime(),
            };

            // Бродкаст всем в комнату (включая отправителя)
            broadcastToTrack(ws.chatTrackId, { type: 'message', data: payload });

            console.log(`[Chat] ${ws.chatUser.username} → ${ws.chatTrackId}: "${text.slice(0, 40)}"`);
            return;
          }

        } catch (e) {
          console.error('[WS] Error:', e);
          ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
        }
      }); // Закрываем ws.on('message')

      // Обработка отключения
        ws.on('close', () => {
    wsClients.delete(ws);
    
    // 🔥 УДАЛЯЕМ ИЗ ОНЛАЙН
    if (ws.userId && onlineUsers.has(ws.userId)) {
      onlineUsers.get(ws.userId).delete(ws);
      
      // Если у пользователя больше нет активных подключений
      if (onlineUsers.get(ws.userId).size === 0) {
        onlineUsers.delete(ws.userId);
        
        // 🔥 УВЕДОМЛЯЕМ ВСЕ ЧАТЫ О СТАТУСЕ "ОФФЛАЙН"
        broadcastUserStatus(ws.userId, false);
      }
    }

    // Удаляем из комнат чатов треков (существующий код)
    if (ws.chatTrackId) {
      const room = chatRooms.get(ws.chatTrackId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) chatRooms.delete(ws.chatTrackId);
        else sendListenersUpdate(ws.chatTrackId);
      }
    }
  });

  ws.on('error', () => {
    wsClients.delete(ws);
    if (ws.userId && onlineUsers.has(ws.userId)) {
      onlineUsers.get(ws.userId).delete(ws);
      if (onlineUsers.get(ws.userId).size === 0) {
        onlineUsers.delete(ws.userId);
        broadcastUserStatus(ws.userId, false);
      }
    }
  });
}); // Закрываем wss.on('connection')

  }) // Закрываем .then()
  .catch(err => console.log('❌ Ошибка подключения к БД:', err));
