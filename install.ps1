# Bulgarian Citizenship Status WhatsApp (Bulgaristan Vatandaslik Takip) - one-line download for Chrome / Brave (no installer):
#   irm https://raw.githubusercontent.com/lones8888/bulgarian-citizenship-status-whatsapp/main/install.ps1 | iex
# Downloads the latest release and extracts the extension to Desktop\bulgarian-citizenship-status-whatsapp.
# Updating uses the same folder, so settings and PINs are kept (then click Reload on the extension card).
function Install-BulgarianCitizenshipStatus {
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $name = 'bulgarian-citizenship-status-whatsapp'
    $url = "https://github.com/lones8888/$name/releases/latest/download/$name.zip"
    $target = Join-Path ([Environment]::GetFolderPath('Desktop')) $name
    $update = Test-Path -LiteralPath (Join-Path $target 'manifest.json')
    $zip = Join-Path $env:TEMP "$name.zip"
    $tmp = Join-Path $env:TEMP ($name + '_' + [guid]::NewGuid().ToString('N'))
    Write-Host 'Indiriliyor / Downloading...'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $src = Join-Path $tmp $name
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $src | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Remove-Item -LiteralPath $zip -Force
    try { Set-Clipboard -Value 'chrome://extensions' } catch { }
    Write-Host "Tamam / Done: $target" -ForegroundColor Green
    if ($update) {
        Write-Host 'Guncelleme: chrome://extensions (panoya kopyalandi; Brave: brave://extensions) > eklenti kartinda Yeniden yukle. Ayarlar ve PIN''ler korunur.'
        Write-Host 'Update: chrome://extensions (copied to clipboard; Brave: brave://extensions) > click Reload on the extension card. Settings and PINs are kept.'
    } else {
        Write-Host 'Sonraki adimlar (Chrome / Brave):'
        Write-Host '  1. Adres cubuguna chrome://extensions yapistir (panoya kopyalandi; Brave: brave://extensions)'
        Write-Host '  2. Sag ustte Gelistirici modu ac'
        Write-Host "  3. Paketlenmemis oge yukle > $target klasorunu sec"
        Write-Host 'Next steps: open chrome://extensions (copied), turn on Developer mode, Load unpacked > select the folder above.'
    }
}
Install-BulgarianCitizenshipStatus
