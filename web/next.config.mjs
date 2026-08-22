/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Prisma грузит нативный движок по пути на диске: собранный в бандл клиент
  // этот путь теряет. Оставляем пакеты внешними, как требует их рантайм.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
  },
};

export default nextConfig;
