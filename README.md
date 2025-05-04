This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Seed 数据脚本运行方式

### 方法一：在 Docker 容器内执行（推荐）

如果后端以 Docker Compose 方式运行，容器内部的数据库地址不需要修改，直接在容器内运行脚本：

```bash
# 假设后端服务在 docker-compose.yml 中名称为 api
# 执行全部 seed 脚本
docker-compose exec api npm run seed:all
# 或仅执行测试用户 seed 脚本
docker-compose exec api npm run seed:testusers
```

这样直接在容器环境读取 `.env` 中的 `DATABASE_URL=postgresql://ddc:ddc@ddc-backend-db:5432/ddc` 即可。

### 方法二：在本机（Host）执行

如果你在 macOS 主机上直接运行 Node 脚本，需要将 `.env` 中的 `DATABASE_URL` 改为容器映射到主机的端口，例如：

```dotenv
# 修改为本地转发端口 15432
DATABASE_URL=postgresql://ddc:ddc@localhost:15432/ddc
```

然后在项目根目录执行：

```bash
npm install
node scripts/createAwards.js
node scripts/seedTestUserData.js
```

### 一键执行所有 Seed 脚本
在容器内运行以下命令，一次性执行所有数据创建和测试数据脚本：

```bash
docker-compose exec ddc-backend-api npm run seed:all
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
