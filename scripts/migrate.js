import { migrate, closeDb } from "../src/db.js";
migrate();
console.log("Database migration complete.");
closeDb();
