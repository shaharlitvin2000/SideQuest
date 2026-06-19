#!/bin/bash

# Flash Arena - Production Deployment Script
# Version: 2.0
# Date: 2026-06-04
# Usage: bash DEPLOY.sh

set -e  # Exit on error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         Flash Arena - Production Deployment                ║"
echo "║                    Version 2.0 Final                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v firebase &> /dev/null; then
    echo "❌ Firebase CLI not found"
    echo "   Install with: npm install -g firebase-tools"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found"
    echo "   Install from: https://nodejs.org"
    exit 1
fi

echo "✅ Firebase CLI installed"
echo "✅ Node.js installed"
echo ""

# Check Firebase login
echo "🔑 Checking Firebase authentication..."
if ! firebase projects:list > /dev/null 2>&1; then
    echo "❌ Not authenticated with Firebase"
    echo "   Run: firebase login"
    exit 1
fi

PROJECTS=$(firebase projects:list)
if [[ ! $PROJECTS =~ "flasharena-f35b1" ]]; then
    echo "❌ flasharena-f35b1 project not accessible"
    echo "   Available projects: $PROJECTS"
    exit 1
fi

echo "✅ Firebase authenticated"
echo "✅ Project flasharena-f35b1 accessible"
echo ""

# Pre-deployment checks
echo "⚠️  PRE-DEPLOYMENT CHECKLIST:"
echo "   Have you:"
echo "   [ ] Deleted API key from Google Cloud Console?"
echo "   [ ] Set admin email in admin-dashboard.html?"
echo "   [ ] Created a database backup?"
echo "   [ ] Tested all 9 tests locally?"
echo ""

read -p "Continue with deployment? (yes/no) " -n 3 -r
echo ""
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

echo ""
echo "🚀 Starting deployment..."
echo ""

# Step 1: Install dependencies
echo "📦 Step 1/5: Installing Cloud Functions dependencies..."
cd firebase/functions
npm install
if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed"
else
    echo "❌ npm install failed"
    exit 1
fi
cd ../..
echo ""

# Step 2: Deploy Cloud Functions
echo "⚡ Step 2/5: Deploying Cloud Functions..."
firebase deploy --only functions
if [ $? -eq 0 ]; then
    echo "✅ Cloud Functions deployed"
else
    echo "❌ Function deployment failed"
    exit 1
fi
echo ""

# Step 3: Deploy Database & Storage Rules
echo "🔐 Step 3/5: Deploying Database & Storage Rules..."
firebase deploy --only database,storage
if [ $? -eq 0 ]; then
    echo "✅ Rules deployed"
else
    echo "❌ Rules deployment failed"
    exit 1
fi
echo ""

# Step 4: Deploy Hosting
echo "🌐 Step 4/5: Deploying Hosting (app)..."
firebase deploy --only hosting
if [ $? -eq 0 ]; then
    echo "✅ Hosting deployed"
else
    echo "❌ Hosting deployment failed"
    exit 1
fi
echo ""

# Step 5: Verify deployment
echo "✔️  Step 5/5: Verifying deployment..."
FUNCTIONS=$(firebase functions:list 2>&1)

if echo "$FUNCTIONS" | grep -q "completeMission"; then
    echo "✅ Functions verified"
else
    echo "⚠️  Could not verify functions (but deployment may have succeeded)"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETE!                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

echo "📋 Next Steps:"
echo ""
echo "1️⃣  Test the app:"
echo "   Open: https://flasharena-f35b1.web.app"
echo ""
echo "2️⃣  Test admin dashboard:"
echo "   Open: https://flasharena-f35b1.web.app/admin-dashboard.html"
echo "   Login with your admin email"
echo ""
echo "3️⃣  Run 9 tests:"
echo "   Follow: DEPLOYMENT_CHECKLIST.md → POST-DEPLOYMENT TESTING"
echo ""
echo "4️⃣  Monitor errors:"
echo "   Check: firebase functions:log"
echo "   Check: Sentry dashboard"
echo ""
echo "5️⃣  Configure monitoring:"
echo "   Follow: ADMIN_SETUP_GUIDE.md"
echo ""

echo "📚 Documentation:"
echo "   - DEPLOYMENT_CHECKLIST.md (for testing)"
echo "   - ADMIN_SETUP_GUIDE.md (for configuration)"
echo "   - MONITORING_GUIDE.md (for daily monitoring)"
echo "   - README_PRODUCTION.md (for overview)"
echo ""

echo "🎉 Deployment successful! You're ready to launch."
echo ""
