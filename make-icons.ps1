# Generates the PWA icons (route line + stops on navy) without any external tools.
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $s = $size / 512.0

  $navy = [System.Drawing.Color]::FromArgb(255, 20, 48, 79)
  $orange = [System.Drawing.Color]::FromArgb(255, 208, 80, 23)
  $white = [System.Drawing.Color]::White

  $g.Clear($navy)

  # route polyline
  $pen = New-Object System.Drawing.Pen($white, [float](26 * $s))
  $pen.StartCap = "Round"; $pen.EndCap = "Round"; $pen.LineJoin = "Round"
  $pts = @(
    (New-Object System.Drawing.PointF([float](120 * $s), [float](390 * $s))),
    (New-Object System.Drawing.PointF([float](250 * $s), [float](170 * $s))),
    (New-Object System.Drawing.PointF([float](330 * $s), [float](300 * $s))),
    (New-Object System.Drawing.PointF([float](410 * $s), [float](150 * $s)))
  )
  $g.DrawLines($pen, $pts)

  # home base (orange square, start of route)
  $hb = 84 * $s
  $brO = New-Object System.Drawing.SolidBrush($orange)
  $g.FillRectangle($brO, [float](120 * $s - $hb/2), [float](390 * $s - $hb/2), [float]$hb, [float]$hb)

  # stops (white circles with orange center)
  $brW = New-Object System.Drawing.SolidBrush($white)
  foreach ($p in @($pts[1], $pts[3])) {
    $r = 52 * $s
    $g.FillEllipse($brW, [float]($p.X - $r/1), [float]($p.Y - $r), [float](2*$r), [float](2*$r) )
  }
  # recenter: FillEllipse expects x,y of bounding box top-left
  $g.Clear($navy)
  $g.DrawLines($pen, $pts)
  $g.FillRectangle($brO, [float](120 * $s - $hb/2), [float](390 * $s - $hb/2), [float]$hb, [float]$hb)
  foreach ($p in @($pts[1], $pts[3])) {
    $r = 52 * $s
    $g.FillEllipse($brW, [float]($p.X - $r), [float]($p.Y - $r), [float](2*$r), [float](2*$r))
    $r2 = 26 * $s
    $g.FillEllipse($brO, [float]($p.X - $r2), [float]($p.Y - $r2), [float](2*$r2), [float](2*$r2))
  }

  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "wrote $outPath"
}

New-Icon 512 (Join-Path $PSScriptRoot "icon-512.png")
New-Icon 192 (Join-Path $PSScriptRoot "icon-192.png")
