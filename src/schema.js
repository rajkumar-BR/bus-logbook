// The tabs and columns of "Bus Logbook Data".
// This is the single source of truth for the spreadsheet layout. It matches the
// architecture document (section 6), so the same workbook can later be imported
// into Google Sheets unchanged.
//
// Column types: text | number | date (YYYY-MM-DD) | datetime (YYYY-MM-DD HH:mm) | bool

export const WORKBOOK_NAME = 'Bus Logbook Data.xlsx';

export const TABS = {
  Schools: [
    ['school_id', 'text'], ['school_name', 'text'], ['short_name', 'text'],
    ['region', 'text'], ['active', 'bool'], ['created_at', 'datetime'],
  ],
  Buses: [
    ['school_id', 'text'], ['bus_no', 'text'], ['reg_no', 'text'], ['make_model', 'text'], ['year', 'number'],
    ['seats', 'number'], ['driver_name', 'text'], ['status', 'text'],
    ['service_every_km', 'number'], ['service_every_days', 'number'], ['active', 'bool'],
  ],
  Routes: [
    ['school_id', 'text'], ['route_id', 'text'], ['route_name', 'text'], ['notes', 'text'],
  ],
  'Route assignments': [
    ['school_id', 'text'], ['bus_no', 'text'], ['route_id', 'text'], ['from_date', 'date'], ['to_date', 'date'],
  ],
  'Daily reports': [
    ['school_id', 'text'], ['report_id', 'text'], ['report_date', 'date'], ['bus_no', 'text'], ['driver_name', 'text'],
    ['income_collected', 'number'], ['expenses', 'number'], ['notes', 'text'], ['entered_by', 'text'], ['entered_at', 'datetime'],
  ],
  Trips: [
    ['school_id', 'text'], ['trip_id', 'text'], ['report_id', 'text'], ['trip_date', 'date'], ['bus_no', 'text'], ['trip_number', 'number'],
    ['origin', 'text'], ['destination', 'text'], ['scheduled_start', 'text'], ['actual_start', 'text'], ['scheduled_end', 'text'], ['actual_end', 'text'],
    ['planned_km', 'number'], ['start_odometer_km', 'number'], ['end_odometer_km', 'number'],
    ['actual_km', 'number'], ['extra_km', 'number'], ['late_by_minutes', 'number'], ['on_time', 'bool'],
    ['photo_link', 'text'], ['notes', 'text'], ['entered_by', 'text'], ['entered_at', 'datetime'],
  ],
  Entries: [
    ['school_id', 'text'], ['entry_id', 'text'], ['bus_no', 'text'], ['kind', 'text'],
    ['date_in', 'date'], ['date_out', 'date'], ['days_off_road', 'number'],
    ['odometer_km', 'number'], ['system', 'text'],
    ['problem_reported', 'text'], ['root_cause', 'text'],
    ['workshop', 'text'], ['bill_no', 'text'],
    ['labour_cost', 'number'], ['total_cost', 'number'],
    ['bill_link', 'text'], ['photo_links', 'text'], ['route_at_time', 'text'],
    ['is_repeat', 'bool'], ['filled_by_ai', 'bool'],
    ['record_status', 'text'], ['replaces_entry_id', 'text'],
    ['entered_by', 'text'], ['entered_at', 'datetime'],
  ],
  'Parts changed': [
    ['school_id', 'text'], ['entry_id', 'text'], ['bus_no', 'text'], ['system', 'text'], ['part_name', 'text'],
    ['position', 'text'], ['removed_part_no', 'text'], ['fitted_part_no', 'text'],
    ['part_cost', 'number'], ['warranty_until', 'date'], ['record_status', 'text'],
  ],
  'Bus documents': [
    ['school_id', 'text'], ['bus_no', 'text'], ['doc_type', 'text'], ['doc_number', 'text'],
    ['valid_until', 'date'], ['file_link', 'text'],
  ],
  Workshops: [
    ['school_id', 'text'], ['workshop_name', 'text'], ['phone', 'text'], ['address', 'text'],
  ],
  Lists: [
    ['school_id', 'text'], ['systems', 'text'], ['entry_kinds', 'text'], ['bus_statuses', 'text'], ['doc_types', 'text'],
  ],
  Settings: [
    ['school_id', 'text'], ['key', 'text'], ['value', 'text'],
  ],
  'Change log': [
    ['timestamp', 'datetime'], ['user', 'text'], ['action', 'text'], ['tab', 'text'],
    ['record_id', 'text'], ['field', 'text'], ['old_value', 'text'], ['new_value', 'text'],
  ],
  'AI summaries': [
    ['bus_no', 'text'], ['generated_at', 'datetime'], ['summary', 'text'], ['based_on_last_entry_id', 'text'],
  ],
};

export const KINDS = {
  BREAKDOWN: 'Breakdown',
  REPAIR: 'Repair',
  SERVICE: 'Scheduled service',
  INSPECTION: 'Inspection',
};

export const STATUS = {
  ON_ROUTE: 'On route',
  IN_WORKSHOP: 'In workshop',
  OUT_OF_SERVICE: 'Out of service',
};

export const DEFAULT_LISTS = {
  school_id: [],
  systems: [
    'Brakes', 'Tyres & alignment', 'Battery & electrical', 'Engine & cooling',
    'Suspension', 'Doors & body', 'AC / fans', 'Clutch & gearbox', 'Other',
  ],
  entry_kinds: Object.values(KINDS),
  bus_statuses: Object.values(STATUS),
  doc_types: ['Fitness certificate', 'Insurance', 'Permit', 'Pollution (PUC)', 'Road tax'],
};

export const DEFAULT_SETTINGS = [
  ['default_service_km', '10000'],
  ['default_service_days', '90'],
  ['repeat_window_days', '180'],
  ['ai_enabled', 'TRUE'],
  ['allowed_users', ''],
  ['reminder_emails', ''],
];

export const columnsOf = (tab) => TABS[tab].map(([name]) => name);
export const typeOf = (tab, col) => (TABS[tab].find(([name]) => name === col) || [])[1] || 'text';
