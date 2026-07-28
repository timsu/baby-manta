-- CreateEnum
CREATE TYPE "WorkerVenue" AS ENUM ('none', 'laptop', 'daytona');

-- CreateEnum
CREATE TYPE "VenueStatus" AS ENUM ('none', 'provisioning', 'active', 'idle', 'stopped', 'failed');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "venueStatus" "VenueStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "venueStoppedAt" TIMESTAMP(3),
ADD COLUMN     "workerVenue" "WorkerVenue" NOT NULL DEFAULT 'none';
