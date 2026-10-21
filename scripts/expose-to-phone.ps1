#Requires -RunAsAdministrator
<#
  Lets a phone on the same network open the web clients served from WSL.

  WSL2 sits behind NAT, so the phone cannot reach it directly. This forwards
  port 5173 on the laptop to WSL and opens that one port in the firewall.
  The WSL address changes on reboot, so run this again after restarting.

    .\scripts\expose-to-phone.ps1           # set up
    .\scripts\expose-to-phone.ps1 -Remove   # undo both changes

  College Wi-Fi often blocks devices from reaching each other. If the phone
  cannot connect, turn on the laptop's Mobile Hotspot and join it from the phone.
#>
param([switch]$Remove)
$port = 5173
$rule = 'Haazir demo 5173'

netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null | Out-Null
if ($Remove) {
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  "Removed the port forward and the firewall rule."
  return
}

$wslIp = ((wsl -d Ubuntu -- hostname -I) -split '\s+')[0]
netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp | Out-Null
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
}
$lan = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress
"Forwarding :$port -> WSL $wslIp`:$port"
"On the phone, open one of:"
$lan | ForEach-Object { "  https://$_`:$port/student.html" }
"The certificate is self-signed: accept the warning once on the phone."
