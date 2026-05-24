-- Limpiamos cualquier fila previa creada bajo el flujo legacy del "usuario demo":
-- el id ahora debe ser el UUID de `auth.users` de Supabase y `password` no existe
-- como columna en este modelo (Supabase es responsable de las credenciales).
DELETE FROM "Lote"
WHERE "userId" IN (SELECT "id" FROM "User" WHERE "email" = 'demo@terrascan.local');

DELETE FROM "User"
WHERE "email" = 'demo@terrascan.local';

ALTER TABLE "User" DROP COLUMN "password";
