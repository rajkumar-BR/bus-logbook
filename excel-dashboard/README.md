# Bus Logbook Excel Dashboard

Open `Bus Logbook Dashboard - Demo.xlsx` in Microsoft Excel. The `.xlsx` is the macro-free preview workbook; use the steps below to make the macro-enabled copy.

The workbook contains:

- `Dashboard`: fleet counts, maintenance spend, and summary alerts.
- `Fleet dashboard`: service status, odometer, cost since service, and recent repair counts per bus.
- `Repeat repairs`: repair and breakdown counts by bus and system over the last 12 months.
- The original workbook data tabs, so the underlying bus, route, entry, part, document, and settings details stay inside the same Excel file.

The included rows are illustrative demo data. The source workbook is `demo-data/Bus Logbook Data.xlsx`; the school’s live workbook is not modified. The macro refreshes the fleet dashboard, repeat-repair matrix, and summary from the editable data tabs in this workbook.

Important: use the latest regenerated workbook. An earlier build shifted blank `school_id` cells and caused the macro to read the wrong columns. Close and discard that older workbook and rebuild the `.xlsm` from this corrected `.xlsx`; replacing only the VBA module is not sufficient.

## Make the macro-enabled copy

The current file is `.xlsx`; Excel must import the provided VBA module once and save a separate `.xlsm` copy. This environment could not automate Excel's VBA editor, so the `.xlsm` must be created in Excel using these steps:

1. Open the latest `Bus Logbook Dashboard - Demo.xlsx` in desktop Microsoft Excel.
2. Open the Visual Basic Editor (Tools → Macro → Visual Basic Editor, or press Option+F11).
3. If you imported an earlier copy, remove its `DashboardRefresh` module first (right-click the module in Project Explorer → Remove DashboardRefresh; choose **No** when asked to export). Then choose File → Import File and select the latest `RefreshDashboard.bas` from this folder. This corrected version avoids optional filter dropdown calls that can fail in Excel for Mac.
4. Return to Excel and run `RefreshBusDashboard` once from Tools → Macro → Macros. This builds the dashboard and adds its refresh button.
5. Choose File → Save As and select **Excel Macro-Enabled Workbook (.xlsm)**. Keep the original `.xlsx` as a clean backup.

After that one-time setup, school staff can open the `.xlsm`, enable macros if prompted, edit the data tabs, and click **Refresh dashboard**. Macro policy in the school's Microsoft 365 environment may prevent running macros; their IT administrator controls that policy.

To regenerate the preview workbook from the demo source data, run `node scripts/build-excel-dashboard.js` from the repository root. The build uses LibreOffice to save a compatibility-clean XLSX, so LibreOffice must be installed on the developer machine. This is only for the developer; the recipient needs desktop Excel to create the `.xlsm` copy and use the macro.