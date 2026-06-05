#!/bin/bash
#
# Extracts Lean WASM distribution and copies library files
# 
# Usage: ./scripts/create-lean-lib.sh
#
# This script:
# 1. Unzips build-Web Assembly.zip
# 2. Extracts lean-4.28.0-pre-linux_wasm32.tar.zst
# 3. Copies bin files to lean-wasm/
# 4. Copies the Init.* .olean files to lean-lib/ (the always-resident base)
#
# Only Init is bundled: it is the implicit prelude every Lean file imports,
# and its import closure is essentially all of Init. Std / Lean / Lake are
# left out here and meant to be loaded on demand (via the manifest) later.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LEAN_WASM_DIR="$PROJECT_ROOT/public/lean-wasm"
ZIP_FILE="$LEAN_WASM_DIR/build-Web Assembly.zip"
LEAN_LIB_DIR="$LEAN_WASM_DIR/lean-lib"

cd "$LEAN_WASM_DIR"

# Step 1: Unzip build-Web Assembly.zip
echo "=== Step 1: Unzipping build-Web Assembly.zip ==="
if [ -f "$ZIP_FILE" ]; then
    unzip -o "$ZIP_FILE"
else
    echo "Zip file not found, skipping: $ZIP_FILE"
fi

# Step 2: Extract .tar.zst file
echo ""
echo "=== Step 2: Extracting .tar.zst ==="
ZSTD_FILE=$(find . -maxdepth 1 -name "*.tar.zst" | head -1)
if [ -n "$ZSTD_FILE" ]; then
    echo "Found: $ZSTD_FILE"
    zstd -d -f "$ZSTD_FILE"
else
    echo "No .tar.zst file found, skipping"
fi

# Step 3: Extract .tar file
echo ""
echo "=== Step 3: Extracting .tar ==="
TAR_FILE=$(find . -maxdepth 1 -name "*.tar" | head -1)
if [ -n "$TAR_FILE" ]; then
    echo "Found: $TAR_FILE"
    tar -xf "$TAR_FILE"
else
    echo "No .tar file found, skipping"
fi

# Find extracted directory (lean-*)
EXTRACTED_DIR=$(find . -maxdepth 1 -type d -name "lean-*" | head -1)
if [ -z "$EXTRACTED_DIR" ]; then
    echo "ERROR: Could not find extracted lean-* directory"
    exit 1
fi
echo "Extracted directory: $EXTRACTED_DIR"

# Step 4: Copy bin files to lean-wasm/
echo ""
echo "=== Step 4: Copying bin files ==="
if [ -d "$EXTRACTED_DIR/bin" ]; then
    cp -v "$EXTRACTED_DIR/bin/"* "$LEAN_WASM_DIR/"
    echo "Copied bin files to $LEAN_WASM_DIR"
else
    echo "WARNING: No bin directory found in $EXTRACTED_DIR"
fi

# Step 5: Copy all .olean* files to lean-lib/
echo ""
echo "=== Step 5: Copying library files to lean-lib/ ==="
# Try both possible directory structures
if [ -d "$EXTRACTED_DIR/lib/lean" ]; then
    LIB_DIR="$EXTRACTED_DIR/lib/lean"
elif [ -d "$EXTRACTED_DIR" ]; then
    LIB_DIR="$EXTRACTED_DIR"
else
    echo "ERROR: Could not find library directory"
    exit 1
fi

# Count files (overall vs Init-only) so the reduction is visible
OLEAN_COUNT=$(find "$LIB_DIR" -name "*.olean" -type f | wc -l | tr -d ' ')
INIT_COUNT=$(find "$LIB_DIR" \( -path "*/Init/*" -o -name "Init.olean" \) -name "*.olean" \
    -not -name "*.olean.server" -not -name "*.olean.private" -type f | wc -l | tr -d ' ')
echo "Found in $LIB_DIR:"
echo "  - $OLEAN_COUNT .olean files total"
echo "  - $INIT_COUNT Init .olean files (bundling these only)"

# Clean and recreate lean-lib directory
rm -rf "$LEAN_LIB_DIR"
mkdir -p "$LEAN_LIB_DIR"

# Bundle Init only. Skip:
#   - Std / Lean / Lake        -> loaded on demand later
#   - *.olean.server           -> only needed for LSP (lean --worker), loaded on demand
#   - *.olean.private          -> not needed to run code
cd "$LIB_DIR"
find . \( -path "./Init/*" -o -name "Init.olean" \) -name "*.olean" \
    -not -name "*.olean.server" -not -name "*.olean.private" -type f | while read file; do
    # Create parent directory
    dir=$(dirname "$file")
    mkdir -p "$LEAN_LIB_DIR/$dir"
    # Copy file
    cp "$file" "$LEAN_LIB_DIR/$file"
done
cd "$LEAN_WASM_DIR"

# Count copied files
TOTAL_FILES=$(find "$LEAN_LIB_DIR" -type f | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$LEAN_LIB_DIR" | cut -f1)
echo ""
echo "Copied to: $LEAN_LIB_DIR"
echo "Total files: $TOTAL_FILES"
echo "Total size: $TOTAL_SIZE"

# Step 6: Cleanup
echo ""
echo "=== Step 6: Cleanup ==="
# Keep the source zip (build-Web Assembly.zip) so the bundle can be
# regenerated later (e.g. to add Std/Lean); only remove the regenerable
# intermediate .tar.zst / .tar extracted from it.
if [ -n "$ZSTD_FILE" ] && [ -f "$ZSTD_FILE" ]; then
    rm "$ZSTD_FILE"
    echo "Deleted: $ZSTD_FILE"
fi
if [ -n "$TAR_FILE" ] && [ -f "$TAR_FILE" ]; then
    rm "$TAR_FILE"
    echo "Deleted: $TAR_FILE"
fi

# Step 7: Create lean-lib.tar.gz bundle
echo ""
echo "=== Step 7: Creating lean-lib.tar.gz ==="
cd "$LEAN_LIB_DIR"
tar -czf "$LEAN_WASM_DIR/lean-lib.tar.gz" .
BUNDLE_SIZE=$(du -sh "$LEAN_WASM_DIR/lean-lib.tar.gz" | cut -f1)
echo "Created: $LEAN_WASM_DIR/lean-lib.tar.gz ($BUNDLE_SIZE)"

echo ""
echo "=== Done ==="
echo "Output directory: $LEAN_LIB_DIR"
echo "Bundle: $LEAN_WASM_DIR/lean-lib.tar.gz ($BUNDLE_SIZE)"
