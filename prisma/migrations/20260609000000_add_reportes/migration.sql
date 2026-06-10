-- CreateTable
CREATE TABLE "Reporte" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "establecimiento" TEXT,
    "urlStorage" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reporte_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reporte_userId_idx" ON "Reporte"("userId");

-- CreateIndex
CREATE INDEX "Reporte_loteId_idx" ON "Reporte"("loteId");

-- AddForeignKey
ALTER TABLE "Reporte" ADD CONSTRAINT "Reporte_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "Lote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
