# Local Backend Setup Guide

This guide helps you run the backend locally and connect to the `datadance-postgres` Docker container.

## Prerequisites

1. **Docker Desktop** with `datadance-postgres` container running
2. **Node.js 18+** installed
3. **PostgreSQL client tools** (optional, for manual database access)

## Step 1: Configure Database Connection

The `datadance-postgres` container is running on `localhost:5432`. Configure your `.env` file:

```bash
# Database connection for local backend
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"

# Other required environment variables
JWT_SECRET="your-secret-key"
JWT_EXPIRES_IN="7d"
PORT=8080
NODE_ENV="development"
```

**Important Notes:**
- Default PostgreSQL username: `postgres`
- Default PostgreSQL password: `postgres`
- Database name: `datadance` (verify this matches your container)
- Port: `5432` (mapped from container to host)

## Step 2: Test Database Connection

Test the database connection:

```bash
node scripts/setupLocalDatabase.js
```

This will verify:
- ✅ DATABASE_URL is configured correctly
- ✅ Database connection is working
- ✅ Current database state (users, DataNFTs, merchants)

## Step 3: Run Database Migrations

If this is the first time setting up, run migrations:

```bash
npm run prisma:migrate
```

This will create all necessary database tables.

## Step 4: Install Dependencies

```bash
npm install
```

## Step 5: Start the Backend Server

### Development Mode (with auto-reload):

```bash
npm run dev
```

The server will start on `http://localhost:8080` (or the PORT specified in `.env`).

### Production Mode:

```bash
npm start
```

## Step 6: Process and Upload Data Pack 4

Once the backend is running and database is connected, you can process and upload data-pack-4.csv:

```bash
node scripts/processAndUploadDataPack4.js
```

This script will:
1. ✅ Read and categorize `data-pack-4.csv` by product category and region
2. ✅ Group data by category-region combinations
3. ✅ Create DataNFTs for each group with dynamic pricing
4. ✅ Use provided copywriting templates for descriptions
5. ✅ Publish all DataNFTs automatically

## Troubleshooting

### Database Connection Issues

**Error: "Connection refused"**
- Check if `datadance-postgres` container is running in Docker Desktop
- Verify the container is exposing port `5432` to the host
- Check Docker Desktop → Containers → `datadance-postgres` → Ports

**Error: "database does not exist"**
- The database name in DATABASE_URL might be incorrect
- Check the actual database name in the container
- You may need to create the database: `CREATE DATABASE datadance;`

**Error: "password authentication failed"**
- Verify the username and password in DATABASE_URL match the container settings
- Default credentials: `postgres:postgres`

### Port Conflicts

If port 8080 is already in use:
- Change `PORT` in `.env` to a different port (e.g., `8081`)
- Or stop the service using port 8080

### Prisma Issues

**Error: "Prisma Client not generated"**
```bash
npm run prisma:generate
```

**Error: "Migration issues"**
```bash
# Reset migrations (WARNING: This will delete all data)
npx prisma migrate reset

# Or create a new migration
npm run prisma:migrate
```

## Verification

After setup, verify everything is working:

1. **Database Connection:**
   ```bash
   node scripts/setupLocalDatabase.js
   ```

2. **Backend API:**
   ```bash
   curl http://localhost:8080/api/health
   # or visit in browser
   ```

3. **View Database:**
   ```bash
   npm run prisma:studio
   # Opens Prisma Studio at http://localhost:5555
   ```

## Next Steps

- ✅ Process data-pack-4.csv: `node scripts/processAndUploadDataPack4.js`
- ✅ Check statistics: `node scripts/checkStats.js`
- ✅ View DataNFTs in Prisma Studio: `npm run prisma:studio`



