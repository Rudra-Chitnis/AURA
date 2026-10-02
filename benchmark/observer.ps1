# AURA Runtime Observer
# Read-only process/resource monitor.
# Does NOT modify AURA.

$Root = Split-Path -Parent $PSScriptRoot
$ReportDir = Join-Path $PSScriptRoot "reports"

New-Item -ItemType Directory -Force $ReportDir | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$CsvPath = Join-Path $ReportDir "aura-runtime-$Timestamp.csv"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "          AURA RUNTIME OBSERVER" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Report: $CsvPath"
Write-Host ""
Write-Host "Start AURA now if it is not already running."
Write-Host "Press Ctrl+C to stop observation."
Write-Host ""

function Get-AuraProcesses {

    $processes = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -match '^(node|python|ollama|mongod|electron)(\.exe)?$'
        }

    foreach ($p in $processes) {

        $name = $p.Name -replace '\.exe$',''
        $role = "unknown"

        if ($name -eq "electron") {
            $role = "electron"
        }
        elseif ($name -eq "ollama") {
            $role = "ollama"
        }
        elseif ($name -eq "mongod") {
            $role = "mongodb"
        }
        elseif ($name -eq "python") {

            if ($p.CommandLine -match 'voice[\\/]voice\.py') {
                $role = "voice"
            }
            else {
                $role = "python"
            }
        }
        elseif ($name -eq "node") {

            if ($p.CommandLine -match 'backend[\\/]server\.js') {
                $role = "backend"
            }
            elseif ($p.CommandLine -match 'nodemon') {
                $role = "backend-dev"
            }
            elseif ($p.CommandLine -match 'vite') {
                $role = "vite"
            }
            elseif ($p.CommandLine -match 'npm.*run dev') {
                $role = "npm-dev"
            }
            elseif ($p.CommandLine -match 'pm2') {
                $role = "pm2"
            }
            else {
                $role = "node"
            }
        }

        try {
            $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop

            [PSCustomObject]@{
                PID       = $p.ProcessId
                Process   = $name
                Role      = $role
                RAM_MB    = [math]::Round($proc.WorkingSet64 / 1MB, 1)
                PrivateMB = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
                Threads   = $proc.Threads.Count
                Handles   = $proc.HandleCount
                CPU_Total = if ($proc.TotalProcessorTime) {
                    [math]::Round($proc.TotalProcessorTime.TotalSeconds, 2)
                } else {
                    0
                }
            }
        }
        catch {
            # Process disappeared between CIM and Get-Process.
        }
    }
}

function Get-SystemSnapshot {

    $os = Get-CimInstance Win32_OperatingSystem

    $cpu = Get-Counter '\Processor(_Total)\% Processor Time' |
        Select-Object -ExpandProperty CounterSamples

    [PSCustomObject]@{
        TotalRAM_MB      = [math]::Round($os.TotalVisibleMemorySize / 1024, 1)
        AvailableRAM_MB  = [math]::Round($os.FreePhysicalMemory / 1024, 1)
        CPU_Total        = [math]::Round($cpu.CookedValue, 2)
    }
}

Write-Host "Observer started." -ForegroundColor Green
Write-Host ""

while ($true) {

    $time = Get-Date
    $processes = @(Get-AuraProcesses)
    $system = Get-SystemSnapshot

    foreach ($p in $processes) {

        $row = [PSCustomObject]@{
            Timestamp       = $time.ToString("yyyy-MM-dd HH:mm:ss")
            PID             = $p.PID
            Process         = $p.Process
            Role            = $p.Role
            RAM_MB          = $p.RAM_MB
            PrivateMB       = $p.PrivateMB
            Threads         = $p.Threads
            Handles         = $p.Handles
            CPU_Total_Sec   = $p.CPU_Total
            System_CPU      = $system.CPU_Total
            Total_RAM_MB    = $system.TotalRAM_MB
            Available_RAM_MB = $system.AvailableRAM_MB
        }

        $row | Export-Csv `
            -Path $CsvPath `
            -Append `
            -NoTypeInformation
    }

    Clear-Host

    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "          AURA RUNTIME OBSERVER" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Time: $($time.ToString('HH:mm:ss'))"
    Write-Host "System CPU: $($system.CPU_Total)%"
    Write-Host "Available RAM: $([math]::Round($system.AvailableRAM_MB / 1024, 2)) GB"
    Write-Host ""
    
    if ($processes.Count -eq 0) {
        Write-Host "No AURA processes detected." -ForegroundColor Yellow
    }
    else {

        $processes |
            Sort-Object RAM_MB -Descending |
            Format-Table `
                PID,
                Role,
                Process,
                @{N="RAM_MB";E={$_.RAM_MB}},
                Threads,
                Handles `
                -AutoSize
    }

    Write-Host ""
    Write-Host "Recording -> $CsvPath" -ForegroundColor DarkGray
    Write-Host "Ctrl+C to stop."

    Start-Sleep -Seconds 1
}