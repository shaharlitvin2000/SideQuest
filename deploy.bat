@echo off
color 0F
cd /d C:\Users\blitv\flash-arena
copy /Y "flash-arena.html" "index.html"
rmdir /s /q .firebase
firebase deploy