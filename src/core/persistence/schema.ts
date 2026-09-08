export type Migration = {
  version: number;
  name: string;
  statements: readonly string[];
};

// append-only after release; never rewrite a released migration
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-product-schema',
    statements: [
      `CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        symbol TEXT NOT NULL,
        accent_hex TEXT NOT NULL,
        uses_tinted_background INTEGER NOT NULL,
        tracks_amount INTEGER NOT NULL,
        amount_unit TEXT,
        quick_amount REAL NOT NULL,
        tracks_time INTEGER NOT NULL,
        start_of_day_minute INTEGER NOT NULL,
        metrics_enabled INTEGER NOT NULL,
        order_key TEXT NOT NULL,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mutation_stamp TEXT NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX idx_boards_active ON boards (deleted_at, archived_at, order_key)`,
      `CREATE TABLE check_ins (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards (id),
        logical_date TEXT NOT NULL,
        occurred_at_utc INTEGER,
        time_zone_id TEXT,
        offset_minutes INTEGER,
        amount REAL,
        note TEXT,
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mutation_stamp TEXT NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX idx_check_ins_board_date ON check_ins (board_id, logical_date, deleted_at)`,
      `CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards (id),
        weekdays_mask INTEGER NOT NULL,
        minute_of_day INTEGER NOT NULL,
        message TEXT,
        enabled INTEGER NOT NULL,
        schedule_state TEXT NOT NULL,
        last_schedule_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mutation_stamp TEXT NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE board_activity_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL REFERENCES boards (id),
        start_date TEXT NOT NULL,
        end_date TEXT,
        mutation_stamp TEXT NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX idx_periods_board ON board_activity_periods (board_id, deleted_at)`,
      `CREATE TABLE reminder_schedule (
        reminder_id TEXT NOT NULL REFERENCES reminders (id),
        weekday INTEGER NOT NULL,
        native_identifier TEXT NOT NULL,
        PRIMARY KEY (reminder_id, weekday)
      )`,
      `CREATE TABLE widget_board_rows (
        board_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        symbol TEXT NOT NULL,
        accent_hex TEXT NOT NULL,
        strip TEXT NOT NULL,
        strip_end_date TEXT NOT NULL
      )`,
      `CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_revision INTEGER NOT NULL,
        selected_icon TEXT NOT NULL DEFAULT 'default',
        icloud_sync_enabled INTEGER NOT NULL DEFAULT 0,
        metrics_education_dismissed TEXT NOT NULL DEFAULT '[]',
        device_id TEXT NOT NULL,
        hlc_wall_time INTEGER NOT NULL DEFAULT 0,
        hlc_counter INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER
      )`,
      `CREATE TABLE mutation_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        mutation_stamp TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        change_token TEXT,
        zone_created INTEGER NOT NULL DEFAULT 0,
        retry_state TEXT,
        last_success_at INTEGER
      )`,
      `CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'settings_mutation_stamp',
    statements: [
      // the settings record syncs as one provider-neutral row, so it needs
      // its own mutation stamp for the same last-writer-wins comparison
      `ALTER TABLE app_settings ADD COLUMN settings_mutation_stamp TEXT`,
    ],
  },
  {
    version: 3,
    name: 'sync_deferred',
    statements: [
      // a fetched record whose parent has not arrived yet cannot be applied
      // in its own page. it waits here instead of rolling the page back,
      // which would stall sync on the same page forever.
      `CREATE TABLE sync_deferred (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        mutation_stamp TEXT NOT NULL,
        payload TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      )`,
    ],
  },
  {
    version: 4,
    name: 'stamp_existing_settings',
    statements: [
      // an install that predates the settings stamp may already hold
      // dismissed metrics education. without a stamp and an outbox row that
      // state would never reach the first sync. the stamp sorts below every
      // real one, so any other device's edit wins - the honest outcome for
      // data we cannot date.
      `UPDATE app_settings
         SET settings_mutation_stamp = '00000000000000-00000-' || device_id
       WHERE id = 1
         AND settings_mutation_stamp IS NULL
         AND metrics_education_dismissed IS NOT NULL
         AND metrics_education_dismissed NOT IN ('[]', '')`,
      `INSERT INTO mutation_outbox (entity_type, entity_id, mutation_stamp, created_at)
       SELECT 'settings', 'app-settings', settings_mutation_stamp, 0
         FROM app_settings
        WHERE id = 1 AND settings_mutation_stamp IS NOT NULL`,
    ],
  },
  {
    version: 5,
    name: 'sync_account_bindings',
    statements: [
      // this local-only binding survives sync toggles and product deletion so
      // an existing store can never upload one icloud account's data to another.
      `CREATE TABLE sync_account_bindings (
        provider TEXT PRIMARY KEY,
        account_digest TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 6,
    name: 'habit_board_settings_fields',
    statements: [
      // existing history retains count semantics; daily behavior is opt-in.
      `ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'count' CHECK (kind IN ('count', 'daily'))`,
      `ALTER TABLE boards ADD COLUMN anchor_relation TEXT CHECK (anchor_relation IN ('after', 'before'))`,
      `ALTER TABLE boards ADD COLUMN anchor_kind TEXT CHECK (anchor_kind IN ('board', 'preset', 'text'))`,
      `ALTER TABLE boards ADD COLUMN anchor_board_id TEXT REFERENCES boards (id)`,
      `ALTER TABLE boards ADD COLUMN anchor_preset TEXT CHECK (anchor_preset IN ('wake', 'lunch', 'dinner', 'sleep'))`,
      `ALTER TABLE boards ADD COLUMN anchor_text TEXT`,
      `ALTER TABLE boards ADD COLUMN usual_time_minute INTEGER CHECK (
        usual_time_minute IS NULL OR (typeof(usual_time_minute) = 'integer'
          AND usual_time_minute BETWEEN 0 AND 1439 AND usual_time_minute % 15 = 0))`,
      `ALTER TABLE boards ADD COLUMN required_in_stack INTEGER NOT NULL DEFAULT 1 CHECK (required_in_stack IN (0, 1))`,
      `ALTER TABLE boards ADD COLUMN earns_coins INTEGER NOT NULL DEFAULT 0 CHECK (earns_coins IN (0, 1))`,
      `ALTER TABLE boards ADD COLUMN coin_cap_per_day INTEGER NOT NULL DEFAULT 1 CHECK (
        typeof(coin_cap_per_day) = 'integer' AND coin_cap_per_day BETWEEN 1 AND 10)`,
      `ALTER TABLE app_settings ADD COLUMN wake_minute INTEGER NOT NULL DEFAULT 420 CHECK (
        typeof(wake_minute) = 'integer' AND wake_minute BETWEEN 0 AND 1439 AND wake_minute % 15 = 0)`,
      `ALTER TABLE app_settings ADD COLUMN lunch_minute INTEGER NOT NULL DEFAULT 720 CHECK (
        typeof(lunch_minute) = 'integer' AND lunch_minute BETWEEN 0 AND 1439 AND lunch_minute % 15 = 0)`,
      `ALTER TABLE app_settings ADD COLUMN dinner_minute INTEGER NOT NULL DEFAULT 1080 CHECK (
        typeof(dinner_minute) = 'integer' AND dinner_minute BETWEEN 0 AND 1439 AND dinner_minute % 15 = 0)`,
      `ALTER TABLE app_settings ADD COLUMN sleep_minute INTEGER NOT NULL DEFAULT 1380 CHECK (
        typeof(sleep_minute) = 'integer' AND sleep_minute BETWEEN 0 AND 1439 AND sleep_minute % 15 = 0)`,
      `ALTER TABLE widget_board_rows ADD COLUMN kind TEXT NOT NULL DEFAULT 'count' CHECK (kind IN ('count', 'daily'))`,
      `UPDATE app_settings SET schema_revision = 6 WHERE id = 1`,
    ],
  },
  {
    version: 7,
    name: 'immutable-habit-actions',
    statements: [
      `CREATE TABLE habit_actions (
        id TEXT PRIMARY KEY NOT NULL,
        command_id TEXT,
        board_id TEXT NOT NULL,
        logical_date TEXT NOT NULL,
        check_in_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('check', 'uncheck', 'move_out', 'move_in', 'policy', 'baseline')),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
        mutation_stamp TEXT NOT NULL,
        policy_json TEXT,
        CHECK ((kind = 'baseline' AND command_id IS NULL) OR (kind != 'baseline' AND command_id IS NOT NULL)),
        CHECK (kind IN ('uncheck', 'policy') OR check_in_id IS NOT NULL),
        CHECK (kind != 'policy' OR check_in_id IS NULL)
      )`,
      `CREATE INDEX idx_habit_actions_scope ON habit_actions (board_id, logical_date, mutation_stamp, id)`,
      `CREATE TRIGGER habit_actions_no_replace BEFORE INSERT ON habit_actions
       WHEN EXISTS (SELECT 1 FROM habit_actions WHERE id = NEW.id)
       BEGIN SELECT RAISE(ABORT, 'habit actions are immutable'); END`,
      `CREATE TRIGGER habit_actions_no_update BEFORE UPDATE ON habit_actions
        BEGIN SELECT RAISE(ABORT, 'habit actions are immutable'); END`,
      `CREATE TRIGGER habit_actions_no_delete BEFORE DELETE ON habit_actions
        BEGIN SELECT RAISE(ABORT, 'habit actions are immutable'); END`,
      `UPDATE app_settings SET schema_revision = 7 WHERE id = 1`,
    ],
  },
];

export const latestSchemaVersion = migrations[migrations.length - 1].version;
