-- CreateTable: AuditLog (audit trail hành động quản trị)
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: AuditLog
CREATE INDEX "AuditLog_admin_id_created_at_idx" ON "AuditLog"("admin_id", "created_at");
CREATE INDEX "AuditLog_target_id_idx" ON "AuditLog"("target_id");
CREATE INDEX "AuditLog_action_created_at_idx" ON "AuditLog"("action", "created_at");

-- CreateIndex: Product.is_active (standalone, bổ sung cho composite sẵn có)
CREATE INDEX "Product_is_active_idx" ON "Product"("is_active");
