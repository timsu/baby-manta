-- Hidden tasks back worker-owned background runs without displaying on the kanban board.
ALTER TABLE "tasks" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "backgroundMode" TEXT;
