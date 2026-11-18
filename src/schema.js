// The tables and columns of the logbook (each "tab" is one Postgres table).
// This is the single source of truth for the data layout: the database tables, the
// import template and the importer all come from it.
//
// Column types: text | number | date (YYYY-MM-DD) | datetime (YYYY-MM-DD HH:mm) | bool

export const WORKBOOK_NAME = 'Bus Logbook Data.xlsx';

export const TABS = {
  Schools: [
    ['school_id', 'text'], ['school_name', 'text'], ['short_name', 'text'],
    ['region', 'text'], ['active', 'bool'], ['created_at', 'datetime'], ['status', 'text'],
  ],
  Buses: [
    ['school_id', 'text'], ['bus_no', 'text'], ['reg_no', 'text'], ['make_model', 'text'], ['year', 'number'],
    ['seats', 'number'], ['driver_name', 'text'], ['status', 'text'],
    ['service_every_km', 'number'], ['service_every_days', 'number'], ['active', 'bool'],
  ],
  Routes: [
    ['school_id', 'text'], ['route_id', 'text'], ['route_name', 'text'], ['notes', 'text'],
    ['expected_start', 'text'], ['expected_end', 'text'], ['expected_evening_start', 'text'], ['expected_evening_end', 'text'],
    ['planned_km', 'number'], ['planned_evening_km', 'number'], ['start_stop', 'text'], ['end_stop', 'text'],
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
    ['photo_link', 'text'], ['notes', 'text'], ['entered_by', 'text'], ['entered_at', 'datetime'], ['session', 'text'],
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
    ['voided_reason', 'text'], ['voided_by', 'text'], ['voided_at', 'datetime'],
  ],
  'Parts changed': [
    ['school_id', 'text'], ['entry_id', 'text'], ['bus_no', 'text'], ['system', 'text'], ['part_name', 'text'],
    ['position', 'text'], ['removed_part_no', 'text'], ['fitted_part_no', 'text'],
    ['part_cost', 'number'], ['warranty_until', 'date'], ['record_status', 'text'],
  ],
  Tyres: [
    ['school_id', 'text'], ['tyre_no', 'text'], ['make', 'text'], ['condition', 'text'],
    ['km_before', 'number'], ['status', 'text'], ['notes', 'text'],
    ['cost', 'number'], ['bought_on', 'date'], ['cost_bus', 'text'],
  ],
  'Tyre fitments': [
    ['school_id', 'text'], ['fitment_id', 'text'], ['tyre_no', 'text'], ['bus_no', 'text'], ['position', 'text'],
    ['fitted_date', 'date'], ['fitted_km', 'number'], ['removed_date', 'date'], ['removed_km', 'number'], ['removed_to', 'text'],
  ],
  'Tyre retreads': [
    ['school_id', 'text'], ['retread_id', 'text'], ['tyre_no', 'text'], ['returned_date', 'date'], ['company', 'text'],
    ['cost', 'number'], ['bus_no', 'text'], ['notes', 'text'], ['bill_link', 'text'],
  ],
  'Bill lines': [
    ['school_id', 'text'], ['entry_id', 'text'], ['line_no', 'number'], ['bus_no', 'text'], ['category', 'text'],
    ['amount', 'number'], ['description', 'text'], ['record_status', 'text'],
  ],
  'Expense items': [
    ['school_id', 'text'], ['expense_id', 'text'], ['bus_no', 'text'], ['expense_date', 'date'], ['category', 'text'],
    ['amount', 'number'], ['note', 'text'], ['record_status', 'text'], ['entered_by', 'text'], ['entered_at', 'datetime'],
  ],
  'Trip settings': [
    ['school_id', 'text'], ['route_id', 'text'], ['effective_from', 'date'], ['start_stop', 'text'], ['end_stop', 'text'],
    ['expected_start', 'text'], ['expected_end', 'text'], ['expected_evening_start', 'text'], ['expected_evening_end', 'text'],
    ['planned_km', 'number'], ['planned_evening_km', 'number'], ['changed_by', 'text'], ['changed_at', 'datetime'], ['day_type', 'text'],
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
    ['school_id', 'text'], ['timestamp', 'datetime'], ['user', 'text'], ['action', 'text'], ['tab', 'text'],
    ['record_id', 'text'], ['field', 'text'], ['old_value', 'text'], ['new_value', 'text'],
  ],
  'AI summaries': [
    ['school_id', 'text'], ['bus_no', 'text'], ['generated_at', 'datetime'], ['summary', 'text'], ['based_on_last_entry_id', 'text'],
  ],
};

export const KINDS = {
  BREAKDOWN: 'Breakdown',
  REPAIR: 'Repair',
  SERVICE: 'Scheduled service',
  INSPECTION: 'Inspection',
};

// Categories management reads expenses by. "Daily running" is the plain per-day total (diesel, toll...) kept in the daily report.
export const EXPENSE_CATEGORIES = ['Body Work', 'Under Chase', 'Electrical Charges', 'Seat', 'Insurance', 'F.C - expense', 'Tax', 'Broker expense'];
export const DAILY_EXPENSE = 'Daily running';
// Costs that are not a repair on the bus: they go in "Add an expense", never on a bill.
export const BUSINESS_EXPENSES = ['Insurance', 'F.C - expense', 'Tax', 'Broker expense'];
// What a bill line can be. Older names are merged into the new ones.
export const BILL_CATEGORIES = ['Brakes', 'Tyres & alignment', 'Electrical Charges', 'Engine & cooling', 'Suspension', 'Body Work', 'AC / fans', 'Clutch & gearbox', 'Under Chase', 'Seat', 'Other'];
export const SYSTEM_ALIASES = { 'Battery & electrical': 'Electrical Charges', 'Doors & body': 'Body Work' };

export const STATUS = {
  ON_ROUTE: 'On route',
  IN_WORKSHOP: 'In workshop',
  OUT_OF_SERVICE: 'Out of service',
};

export const DEFAULT_LISTS = {
  school_id: [],
  systems: BILL_CATEGORIES,
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
