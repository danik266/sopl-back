# SOPL Backend Deploy

## 1. First setup on the server

```bash
cd /var/www
git clone https://github.com/danik266/sopl-back.git
cd sopl-back
npm ci
cp .env.example .env
nano .env
```

Required values in `.env`:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/sopl
JWT_SECRET=change_this_to_a_long_random_secret
```

## 2. Run with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Check the API:

```bash
curl http://127.0.0.1:5000/api/health
```

## 3. Update deploy

```bash
cd /var/www/sopl-back
git pull origin main
npm ci
pm2 reload sopl-back
pm2 logs sopl-back
```

## 4. Nginx proxy

Use this for `api.your-domain.com`:

```nginx
server {
    server_name api.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

After DNS points to the server:

```bash
certbot --nginx -d api.your-domain.com
```

The app should use:

```env
EXPO_PUBLIC_API_URL=https://api.your-domain.com/api
EXPO_PUBLIC_WS_URL=wss://api.your-domain.com
```
