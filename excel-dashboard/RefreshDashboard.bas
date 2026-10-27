Attribute VB_Name = "DashboardRefresh"
Option Explicit

Public Sub RefreshBusDashboard()
    Dim wb As Workbook
    Dim wsBuses As Worksheet, wsEntries As Worksheet, wsRoutes As Worksheet
    Dim wsAssignments As Worksheet, wsLists As Worksheet, wsSettings As Worksheet
    Dim wsFleet As Worksheet, wsRepeats As Worksheet, wsDashboard As Worksheet
    Dim todayDate As Date, yearStart As Date, yearSpend As Double
    Dim busHeader As Long, entryHeader As Long, routeHeader As Long
    Dim assignHeader As Long, listHeader As Long, settingHeader As Long
    Dim busRow As Long, entryRow As Long, outRow As Long, systemCol As Long
    Dim busNo As String, busStatus As String, routeId As String, routeName As String
    Dim kind As String, systemName As String, recordStatus As String
    Dim busNoCol As Long, activeCol As Long, statusCol As Long
    Dim entryBusCol As Long, kindCol As Long, dateCol As Long, odoCol As Long
    Dim costCol As Long, systemColEntry As Long, entryIdCol As Long, entryStatusCol As Long
    Dim serviceKmCol As Long, serviceDaysCol As Long, dateIn As Date
    Dim lastServiceDate As Date, latestOdo As Double, serviceOdo As Double
    Dim hasService As Boolean, serviceIntervalKm As Double, serviceIntervalDays As Double
    Dim kmLeft As Double, daysLeft As Long, progress As Double
    Dim serviceState As String, spentSinceService As Double, repairs12 As Long
    Dim onRouteCount As Long, workshopCount As Long, dueCount As Long, busCount As Long
    Dim systems() As String, systemCount As Long, matrixTotal As Long, repeatedPairs As Long
    Dim repeatCount As Long, rowOut As Long, colOut As Long, currentSetting As Double
    Dim sheetName As Variant

    On Error GoTo HandleError
    Application.ScreenUpdating = False
    Application.EnableEvents = False

    Set wb = ThisWorkbook
    Set wsBuses = wb.Worksheets("Buses")
    Set wsEntries = wb.Worksheets("Entries")
    Set wsRoutes = wb.Worksheets("Routes")
    Set wsAssignments = wb.Worksheets("Route assignments")
    Set wsLists = wb.Worksheets("Lists")
    Set wsSettings = wb.Worksheets("Settings")
    Set wsFleet = wb.Worksheets("Fleet dashboard")
    Set wsRepeats = wb.Worksheets("Repeat repairs")
    Set wsDashboard = wb.Worksheets("Dashboard")

    todayDate = Date
    yearStart = DateSerial(Year(todayDate), 1, 1)
    busHeader = 1
    entryHeader = 1
    routeHeader = 1
    assignHeader = 1
    listHeader = 1
    settingHeader = 1

    busNoCol = HeaderColumn(wsBuses, "bus_no", busHeader)
    activeCol = HeaderColumn(wsBuses, "active", busHeader)
    statusCol = HeaderColumn(wsBuses, "status", busHeader)
    entryIdCol = HeaderColumn(wsEntries, "entry_id", entryHeader)
    entryBusCol = HeaderColumn(wsEntries, "bus_no", entryHeader)
    kindCol = HeaderColumn(wsEntries, "kind", entryHeader)
    dateCol = HeaderColumn(wsEntries, "date_in", entryHeader)
    odoCol = HeaderColumn(wsEntries, "odometer_km", entryHeader)
    costCol = HeaderColumn(wsEntries, "total_cost", entryHeader)
    systemColEntry = HeaderColumn(wsEntries, "system", entryHeader)
    entryStatusCol = HeaderColumn(wsEntries, "record_status", entryHeader)
    serviceKmCol = HeaderColumn(wsBuses, "service_every_km", busHeader)
    serviceDaysCol = HeaderColumn(wsBuses, "service_every_days", busHeader)

    serviceIntervalKm = SettingNumber(wsSettings, "default_service_km", 10000)
    serviceIntervalDays = SettingNumber(wsSettings, "default_service_days", 90)

    PrepareSheet wsFleet
    PrepareSheet wsRepeats
    PrepareSheet wsDashboard
    wsFleet.Range("A1:J1").Merge
    wsFleet.Range("A1").Value = "Fleet service view"
    wsFleet.Range("A2:J2").Merge
    wsFleet.Range("A2").Value = "Refreshed " & Format$(Now, "dd mmm yyyy hh:mm") & " | Default service: " & Format$(serviceIntervalKm, "#,##0") & " km or " & CStr(serviceIntervalDays) & " days"
    wsFleet.Range("A4:J4").Value = Array("Bus", "Route", "Status", "Odometer km", "Last service", "Service status", "Km to service", "Days to service", "Spend since service (INR)", "Repairs - 12 mo")
    StyleTitle wsFleet.Range("A1:J1")
    StyleHeader wsFleet.Range("A4:J4")
    outRow = 5

    For busRow = 2 To LastRow(wsBuses, busNoCol)
        busNo = Trim$(CStr(wsBuses.Cells(busRow, busNoCol).Value))
        If Len(busNo) > 0 And IsActiveBus(wsBuses.Cells(busRow, activeCol).Value) Then
            busCount = busCount + 1
            busStatus = Trim$(CStr(wsBuses.Cells(busRow, statusCol).Value))
            If Len(busStatus) = 0 Then busStatus = "On route"
            If busStatus = "On route" Then onRouteCount = onRouteCount + 1
            If busStatus = "In workshop" Then workshopCount = workshopCount + 1

            routeName = CurrentRoute(wsAssignments, wsRoutes, busNo, todayDate)
            lastServiceDate = 0
            latestOdo = 0
            serviceOdo = 0
            hasService = False
            spentSinceService = 0
            repairs12 = 0

            For entryRow = 2 To LastRow(wsEntries, entryBusCol)
                If Trim$(CStr(wsEntries.Cells(entryRow, entryBusCol).Value)) = busNo Then
                    recordStatus = Trim$(CStr(wsEntries.Cells(entryRow, entryStatusCol).Value))
                    If recordStatus <> "Corrected" And Len(CStr(wsEntries.Cells(entryRow, entryIdCol).Value)) > 0 Then
                        kind = Trim$(CStr(wsEntries.Cells(entryRow, kindCol).Value))
                        dateIn = SafeDate(wsEntries.Cells(entryRow, dateCol).Value)
                        If IsNumeric(wsEntries.Cells(entryRow, odoCol).Value) Then
                            If CDbl(wsEntries.Cells(entryRow, odoCol).Value) > latestOdo Then latestOdo = CDbl(wsEntries.Cells(entryRow, odoCol).Value)
                        End If
                        If kind = "Scheduled service" And dateIn > 0 Then
                            If Not hasService Or dateIn >= lastServiceDate Then
                                hasService = True
                                lastServiceDate = dateIn
                                serviceOdo = Val(wsEntries.Cells(entryRow, odoCol).Value)
                            End If
                        End If
                    End If
                End If
            Next entryRow

            For entryRow = 2 To LastRow(wsEntries, entryBusCol)
                If Trim$(CStr(wsEntries.Cells(entryRow, entryBusCol).Value)) = busNo Then
                    recordStatus = Trim$(CStr(wsEntries.Cells(entryRow, entryStatusCol).Value))
                    If recordStatus <> "Corrected" And Len(CStr(wsEntries.Cells(entryRow, entryIdCol).Value)) > 0 Then
                        kind = Trim$(CStr(wsEntries.Cells(entryRow, kindCol).Value))
                        dateIn = SafeDate(wsEntries.Cells(entryRow, dateCol).Value)
                        If (kind = "Repair" Or kind = "Breakdown") And dateIn >= DateAdd("d", -365, todayDate) And dateIn <= todayDate Then repairs12 = repairs12 + 1
                        If kind <> "Scheduled service" And (Not hasService Or dateIn > lastServiceDate) Then spentSinceService = spentSinceService + Val(wsEntries.Cells(entryRow, costCol).Value)
                        If dateIn >= yearStart And dateIn <= todayDate Then yearSpend = yearSpend + Val(wsEntries.Cells(entryRow, costCol).Value)
                    End If
                End If
            Next entryRow

            If hasService Then
                currentSetting = Val(wsBuses.Cells(busRow, serviceKmCol).Value)
                If currentSetting <= 0 Then currentSetting = serviceIntervalKm
                kmLeft = currentSetting - (latestOdo - serviceOdo)
                currentSetting = Val(wsBuses.Cells(busRow, serviceDaysCol).Value)
                If currentSetting <= 0 Then currentSetting = serviceIntervalDays
                daysLeft = CLng(currentSetting - DateDiff("d", lastServiceDate, todayDate))
                progress = MaxNumber((latestOdo - serviceOdo) / ValOrDefault(wsBuses.Cells(busRow, serviceKmCol).Value, serviceIntervalKm), DateDiff("d", lastServiceDate, todayDate) / ValOrDefault(wsBuses.Cells(busRow, serviceDaysCol).Value, serviceIntervalDays))
                If progress >= 1 Then
                    serviceState = "OVERDUE"
                    dueCount = dueCount + 1
                ElseIf progress >= 0.85 Then
                    serviceState = "DUE SOON"
                    dueCount = dueCount + 1
                Else
                    serviceState = "OK"
                End If
            Else
                kmLeft = 0
                daysLeft = 0
                serviceState = "No service recorded"
            End If

            wsFleet.Cells(outRow, 1).Value = busNo
            wsFleet.Cells(outRow, 2).Value = routeName
            wsFleet.Cells(outRow, 3).Value = busStatus
            wsFleet.Cells(outRow, 4).Value = latestOdo
            If hasService Then wsFleet.Cells(outRow, 5).Value = lastServiceDate
            wsFleet.Cells(outRow, 6).Value = serviceState
            If hasService Then
                wsFleet.Cells(outRow, 7).Value = kmLeft
                wsFleet.Cells(outRow, 8).Value = daysLeft
            End If
            wsFleet.Cells(outRow, 9).Value = spentSinceService
            wsFleet.Cells(outRow, 10).Value = repairs12
            outRow = outRow + 1
        End If
    Next busRow

    wsFleet.Columns("A:J").AutoFit
    wsFleet.Columns("E").NumberFormat = "dd mmm yyyy"
    wsFleet.Columns("D").NumberFormat = "#,##0"
    wsFleet.Columns("G").NumberFormat = "#,##0"
    wsFleet.Columns("I").NumberFormat = "#,##0"
    HighlightStatuses wsFleet, 5, outRow - 1
    wsFleet.Activate
    ActiveWindow.FreezePanes = False
    wsFleet.Range("A5").Select
    ActiveWindow.FreezePanes = True

    systemCount = 0
    systemCol = HeaderColumn(wsLists, "systems", listHeader)
    For entryRow = 2 To LastRow(wsLists, systemCol)
        systemName = Trim$(CStr(wsLists.Cells(entryRow, systemCol).Value))
        If Len(systemName) > 0 And systemName <> "Other" Then
            If Not HasSystem(systems, systemCount, systemName) Then
                systemCount = systemCount + 1
                ReDim Preserve systems(1 To systemCount)
                systems(systemCount) = systemName
            End If
        End If
    Next entryRow

    wsRepeats.Range(wsRepeats.Cells(1, 1), wsRepeats.Cells(1, systemCount + 2)).Merge
    wsRepeats.Cells(1, 1).Value = "Repeat repairs - last 12 months"
    wsRepeats.Range(wsRepeats.Cells(2, 1), wsRepeats.Cells(2, systemCount + 2)).Merge
    wsRepeats.Cells(2, 1).Value = "Repair and breakdown counts by bus and system. Counts of 2 or more should be reviewed."
    wsRepeats.Cells(4, 1).Value = "Bus"
    For systemCol = 1 To systemCount
        wsRepeats.Cells(4, systemCol + 1).Value = systems(systemCol)
    Next systemCol
    wsRepeats.Cells(4, systemCount + 2).Value = "Total"
    StyleTitle wsRepeats.Range(wsRepeats.Cells(1, 1), wsRepeats.Cells(1, systemCount + 2))
    StyleHeader wsRepeats.Range(wsRepeats.Cells(4, 1), wsRepeats.Cells(4, systemCount + 2))
    rowOut = 5
    For busRow = 2 To LastRow(wsBuses, busNoCol)
        busNo = Trim$(CStr(wsBuses.Cells(busRow, busNoCol).Value))
        If Len(busNo) > 0 And IsActiveBus(wsBuses.Cells(busRow, activeCol).Value) Then
            wsRepeats.Cells(rowOut, 1).Value = busNo
            matrixTotal = 0
            For systemCol = 1 To systemCount
                repeatCount = 0
                For entryRow = 2 To LastRow(wsEntries, entryBusCol)
                    If Trim$(CStr(wsEntries.Cells(entryRow, entryBusCol).Value)) = busNo _
                        And Trim$(CStr(wsEntries.Cells(entryRow, systemColEntry).Value)) = systems(systemCol) _
                        And (Trim$(CStr(wsEntries.Cells(entryRow, kindCol).Value)) = "Repair" Or Trim$(CStr(wsEntries.Cells(entryRow, kindCol).Value)) = "Breakdown") _
                        And Trim$(CStr(wsEntries.Cells(entryRow, entryStatusCol).Value)) <> "Corrected" _
                        And SafeDate(wsEntries.Cells(entryRow, dateCol).Value) >= DateAdd("d", -365, todayDate) _
                        And SafeDate(wsEntries.Cells(entryRow, dateCol).Value) <= todayDate Then repeatCount = repeatCount + 1
                Next entryRow
                wsRepeats.Cells(rowOut, systemCol + 1).Value = repeatCount
                matrixTotal = matrixTotal + repeatCount
                If repeatCount >= 2 Then repeatedPairs = repeatedPairs + 1
            Next systemCol
            wsRepeats.Cells(rowOut, systemCount + 2).Value = matrixTotal
            rowOut = rowOut + 1
        End If
    Next busRow
    wsRepeats.Columns.AutoFit
    If rowOut > 5 And systemCount > 0 Then
        With wsRepeats.Range(wsRepeats.Cells(5, 2), wsRepeats.Cells(rowOut - 1, systemCount + 1))
            .FormatConditions.Delete
            .FormatConditions.Add Type:=xlCellValue, Operator:=xlGreaterEqual, Formula1:="2"
            .FormatConditions(1).Interior.Color = RGB(252, 226, 221)
            .FormatConditions.Add Type:=xlCellValue, Operator:=xlEqual, Formula1:="1"
            .FormatConditions(2).Interior.Color = RGB(255, 240, 194)
        End With
    End If
    wsDashboard.Range("A1:H1").Merge
    wsDashboard.Range("A1").Value = "BUS LOGBOOK  /  FLEET DASHBOARD"
    wsDashboard.Range("A2:H2").Merge
    wsDashboard.Range("A2").Value = "Updated " & Format$(Now, "dd mmm yyyy hh:mm") & " | Edit data tabs, then run RefreshBusDashboard"
    wsDashboard.Range("A4:B4").Merge: wsDashboard.Range("A4").Value = "ACTIVE BUSES"
    wsDashboard.Range("A5:B6").Merge: wsDashboard.Range("A5").Value = busCount
    wsDashboard.Range("C4:D4").Merge: wsDashboard.Range("C4").Value = "IN WORKSHOP"
    wsDashboard.Range("C5:D6").Merge: wsDashboard.Range("C5").Value = workshopCount
    wsDashboard.Range("E4:F4").Merge: wsDashboard.Range("E4").Value = "SERVICE DUE / OVERDUE"
    wsDashboard.Range("E5:F6").Merge: wsDashboard.Range("E5").Value = dueCount
    wsDashboard.Range("G4:H4").Merge: wsDashboard.Range("G4").Value = "MAINTENANCE SPEND THIS YEAR"
    wsDashboard.Range("G5:H6").Merge: wsDashboard.Range("G5").Value = yearSpend
    wsDashboard.Range("G5").NumberFormat = """INR ""#,##0"
    wsDashboard.Range("A8:D8").Merge: wsDashboard.Range("A8").Value = "SERVICE WATCH"
    wsDashboard.Range("E8:H8").Merge: wsDashboard.Range("E8").Value = "REPEAT REPAIRS"
    wsDashboard.Range("A9:D10").Merge
    If dueCount > 0 Then
        wsDashboard.Range("A9").Value = CStr(dueCount) & " bus(es) due or overdue for service"
    Else
        wsDashboard.Range("A9").Value = "No service alerts based on current records"
    End If
    wsDashboard.Range("E9:H10").Merge
    wsDashboard.Range("E9").Value = CStr(repeatedPairs) & " bus/system pair(s) have 2+ repairs"
    wsDashboard.Range("A12:H12").Merge: wsDashboard.Range("A12").Value = "WORKBOOK CONTENTS"
    wsDashboard.Range("A13:H14").Merge
    wsDashboard.Range("A13").Value = "Fleet dashboard: per-bus service and spending status. Repeat repairs: 12-month counts by bus and system. The other tabs contain editable bus, route, maintenance, parts, document, workshop, settings and change-log details."
    wsDashboard.Range("A16:H16").Merge
    wsDashboard.Range("A16").Value = "Demo records are illustrative. Replace with approved school data before operational use."
    wsDashboard.Columns("A:H").ColumnWidth = 19
    wsDashboard.Range("A1:H1").RowHeight = 38
    wsDashboard.Range("A9:H10").WrapText = True
    wsDashboard.Range("A13:H14").WrapText = True
    wsDashboard.Rows("9:10").RowHeight = 28
    wsDashboard.Rows("13:14").RowHeight = 32
    wsDashboard.Rows("5:6").RowHeight = 25
    StyleTitle wsDashboard.Range("A1:H1")
    StyleHeader wsDashboard.Range("A8:D8")
    StyleHeader wsDashboard.Range("E8:H8")
    StyleHeader wsDashboard.Range("A12:H12")
    StyleCards wsDashboard
    AddRefreshButton wsDashboard
    wsDashboard.Activate
    wsDashboard.Range("A1").Select

    Application.EnableEvents = True
    Application.ScreenUpdating = True
    MsgBox "Dashboard refreshed from the workbook data.", vbInformation, "Bus Logbook"
    Exit Sub

HandleError:
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    MsgBox "Dashboard refresh failed: " & Err.Description, vbExclamation, "Bus Logbook"
End Sub

Private Function HeaderColumn(ByVal ws As Worksheet, ByVal headerName As String, ByVal headerRow As Long) As Long
    Dim lastCol As Long, col As Long
    lastCol = ws.Cells(headerRow, ws.Columns.Count).End(xlToLeft).Column
    For col = 1 To lastCol
        If LCase$(Trim$(CStr(ws.Cells(headerRow, col).Value))) = LCase$(headerName) Then
            HeaderColumn = col
            Exit Function
        End If
    Next col
    Err.Raise vbObjectError + 101, "RefreshBusDashboard", "Column '" & headerName & "' is missing from " & ws.Name
End Function

Private Sub PrepareSheet(ByVal ws As Worksheet)
    Dim index As Long
    For index = ws.Shapes.Count To 1 Step -1
        ws.Shapes(index).Delete
    Next index
    ws.AutoFilterMode = False
    ws.Cells.UnMerge
    ws.Cells.Clear
End Sub

Private Function LastRow(ByVal ws As Worksheet, ByVal keyColumn As Long) As Long
    LastRow = ws.Cells(ws.Rows.Count, keyColumn).End(xlUp).Row
    If LastRow < 1 Then LastRow = 1
End Function

Private Function SafeDate(ByVal value As Variant) As Date
    If IsDate(value) Then SafeDate = DateValue(CDate(value)) Else SafeDate = 0
End Function

Private Function IsActiveBus(ByVal value As Variant) As Boolean
    IsActiveBus = Not (VarType(value) = vbBoolean And value = False) And LCase$(Trim$(CStr(value))) <> "false" And LCase$(Trim$(CStr(value))) <> "no" And Trim$(CStr(value)) <> "0"
End Function

Private Function SettingNumber(ByVal ws As Worksheet, ByVal settingName As String, ByVal fallback As Double) As Double
    Dim keyCol As Long, valueCol As Long, row As Long
    keyCol = HeaderColumn(ws, "key", 1)
    valueCol = HeaderColumn(ws, "value", 1)
    For row = 2 To LastRow(ws, keyCol)
        If Trim$(CStr(ws.Cells(row, keyCol).Value)) = settingName Then
            If IsNumeric(ws.Cells(row, valueCol).Value) Then SettingNumber = CDbl(ws.Cells(row, valueCol).Value)
            Exit For
        End If
    Next row
    If SettingNumber <= 0 Then SettingNumber = fallback
End Function

Private Function ValOrDefault(ByVal value As Variant, ByVal fallback As Double) As Double
    If IsNumeric(value) And Val(value) > 0 Then ValOrDefault = CDbl(value) Else ValOrDefault = fallback
End Function

Private Function MaxNumber(ByVal firstValue As Double, ByVal secondValue As Double) As Double
    If firstValue > secondValue Then MaxNumber = firstValue Else MaxNumber = secondValue
End Function

Private Function CurrentRoute(ByVal wsAssignments As Worksheet, ByVal wsRoutes As Worksheet, ByVal busNo As String, ByVal onDate As Date) As String
    Dim busCol As Long, routeCol As Long, fromCol As Long, toCol As Long
    Dim routeIdCol As Long, nameCol As Long, row As Long, routeRow As Long
    Dim routeId As String, fromDate As Date, toDate As Date
    busCol = HeaderColumn(wsAssignments, "bus_no", 1)
    routeCol = HeaderColumn(wsAssignments, "route_id", 1)
    fromCol = HeaderColumn(wsAssignments, "from_date", 1)
    toCol = HeaderColumn(wsAssignments, "to_date", 1)
    routeIdCol = HeaderColumn(wsRoutes, "route_id", 1)
    nameCol = HeaderColumn(wsRoutes, "route_name", 1)
    For row = 2 To LastRow(wsAssignments, busCol)
        If Trim$(CStr(wsAssignments.Cells(row, busCol).Value)) = busNo Then
            fromDate = SafeDate(wsAssignments.Cells(row, fromCol).Value)
            toDate = SafeDate(wsAssignments.Cells(row, toCol).Value)
            If fromDate > 0 And fromDate <= onDate And (toDate = 0 Or toDate >= onDate) Then
                routeId = Trim$(CStr(wsAssignments.Cells(row, routeCol).Value))
                For routeRow = 2 To LastRow(wsRoutes, routeIdCol)
                    If Trim$(CStr(wsRoutes.Cells(routeRow, routeIdCol).Value)) = routeId Then
                        CurrentRoute = Trim$(CStr(wsRoutes.Cells(routeRow, nameCol).Value))
                        Exit Function
                    End If
                Next routeRow
            End If
        End If
    Next row
End Function

Private Function HasSystem(ByRef systems() As String, ByVal count As Long, ByVal value As String) As Boolean
    Dim index As Long
    For index = 1 To count
        If systems(index) = value Then HasSystem = True: Exit Function
    Next index
End Function

Private Sub StyleTitle(ByVal target As Range)
    With target
        .Interior.Color = RGB(23, 49, 43)
        .Font.Name = "Aptos Display"
        .Font.Size = 20
        .Font.Bold = True
        .Font.Color = RGB(255, 255, 255)
        .VerticalAlignment = xlCenter
    End With
End Sub

Private Sub StyleHeader(ByVal target As Range)
    With target
        .Interior.Color = RGB(23, 107, 85)
        .Font.Bold = True
        .Font.Color = RGB(255, 255, 255)
        .WrapText = True
        .VerticalAlignment = xlCenter
    End With
End Sub

Private Sub StyleCards(ByVal ws As Worksheet)
    With ws.Range("A4:H6")
        .Interior.Color = RGB(229, 242, 236)
        .Borders(xlEdgeBottom).Color = RGB(217, 227, 221)
        .VerticalAlignment = xlCenter
    End With
    ws.Range("A4:H4").Font.Bold = True
    ws.Range("A5:H6").Font.Size = 22
    ws.Range("A5:H6").Font.Bold = True
    ws.Range("A9:H10").Font.Size = 13
    ws.Range("A9:H10").Font.Bold = True
End Sub

Private Sub AddRefreshButton(ByVal ws As Worksheet)
    Dim button As Shape
    On Error Resume Next
    ws.Shapes("btnRefreshDashboard").Delete
    On Error GoTo 0
    Set button = ws.Shapes.AddShape(msoShapeRoundedRectangle, ws.Range("F18").Left, ws.Range("F18").Top, 190, 32)
    button.Name = "btnRefreshDashboard"
    button.TextFrame.Characters.Text = "Refresh dashboard"
    button.OnAction = "RefreshBusDashboard"
    button.Fill.ForeColor.RGB = RGB(23, 107, 85)
    button.Line.Visible = msoFalse
    button.TextFrame.Characters.Font.Color = RGB(255, 255, 255)
    button.TextFrame.Characters.Font.Bold = True
End Sub

Private Sub HighlightStatuses(ByVal ws As Worksheet, ByVal firstRow As Long, ByVal lastRow As Long)
    Dim row As Long
    For row = firstRow To lastRow
        Select Case CStr(ws.Cells(row, 6).Value)
            Case "OVERDUE"
                ws.Cells(row, 6).Interior.Color = RGB(252, 226, 221)
                ws.Cells(row, 6).Font.Color = RGB(156, 47, 31)
                ws.Cells(row, 6).Font.Bold = True
            Case "DUE SOON"
                ws.Cells(row, 6).Interior.Color = RGB(255, 240, 194)
                ws.Cells(row, 6).Font.Color = RGB(128, 85, 0)
                ws.Cells(row, 6).Font.Bold = True
        End Select
    Next row
End Sub