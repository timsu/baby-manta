/*
  Warnings:

  - You are about to alter the column `seq` on the `messages` table. The data in that column could be lost. The data in that column will be cast from `BigInt` to `Integer`.

*/
-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "seq" SET DATA TYPE INTEGER;
