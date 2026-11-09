#!/bin/sh
# Ugradi snimljenu naraciju u video: glazba i efekti se stišaju dok se govori.
#   video/predaja/dodaj_naraciju.sh ~/Downloads/naracija.wav
# Izlaz: video/eSidro-predaja-naracija.mp4 (slika se samo kopira, bez ponovnog kodiranja)
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
NAR=${1:?"zadaj putanju do naracija.wav"}
ffmpeg -y -loglevel error -i "$DIR/eSidro-predaja.mp4" -i "$NAR" -filter_complex "\
[1:a]aresample=48000,highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=150,pan=stereo|c0=c0|c1=c0,volume=1.4,asplit=2[vo][sc];\
[0:a]volume=0.8[bg];\
[bg][sc]sidechaincompress=threshold=0.02:ratio=8:attack=30:release=450[duck];\
[vo][duck]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]" \
  -map 0:v -map "[out]" -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest "$DIR/eSidro-predaja-naracija.mp4"
echo "gotovo: $DIR/eSidro-predaja-naracija.mp4"
