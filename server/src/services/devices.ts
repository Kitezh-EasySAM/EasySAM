/** Список устройств со сводкой — общий для GET /api/devices и выгрузки агентов в Excel (services/reports.ts). */
import { config } from "../config.ts";
import { all, type DB } from "../db.ts";
import { AGENT_STATUS_SQL } from "./ingest.ts";

export interface DeviceRow {
  id: number;
  serial_number: string;
  hostname: string;
  os: string | null;
  last_seen: string | null;
  agent_last_seen: string | null;
  agent_status: "online" | "offline" | "lost" | "no_agent";
  employee_id: number | null;
  employee: string | null;
  department: string | null;
  software_count: number;
  forbidden_count: number;
  unknown_count: number;
}

/** Все ПК со счётчиками ПО (всего, запрещённого, неопознанного) и статусом агента. */
export function listDevices(db: DB): DeviceRow[] {
  return all<DeviceRow>(
    db,
    `SELECT d.id, d.serial_number, d.hostname, d.os, d.last_seen, d.agent_last_seen, ${AGENT_STATUS_SQL(config.agentOnlineSeconds)} AS agent_status,
       d.employee_id, e.full_name AS employee, e.department,
       (SELECT COUNT(*) FROM installation i WHERE i.device_serial = d.serial_number AND i.is_noise = 0) AS software_count,
       (SELECT COUNT(*) FROM installation i JOIN software_catalog c ON c.id = i.catalog_id
          WHERE i.device_serial = d.serial_number AND c.internal_status = 'forbidden') AS forbidden_count,
       (SELECT COUNT(*) FROM installation i WHERE i.device_serial = d.serial_number AND i.is_noise = 0 AND i.catalog_id IS NULL) AS unknown_count
     FROM device d LEFT JOIN employee e ON e.id = d.employee_id ORDER BY forbidden_count DESC, d.serial_number`,
  );
}
