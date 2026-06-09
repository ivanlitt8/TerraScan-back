-- CreateTable
CREATE TABLE "Establecimiento" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Establecimiento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Establecimiento_userId_idx" ON "Establecimiento"("userId");

-- AlterTable
ALTER TABLE "Lote" ADD COLUMN "establecimientoId" TEXT;

-- CreateIndex
CREATE INDEX "Lote_establecimientoId_idx" ON "Lote"("establecimientoId");

-- AddForeignKey
ALTER TABLE "Establecimiento" ADD CONSTRAINT "Establecimiento_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lote" ADD CONSTRAINT "Lote_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "Establecimiento"("id") ON DELETE SET NULL ON UPDATE CASCADE;
