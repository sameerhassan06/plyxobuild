echo "🚀 Setting up DesignHub Platform..."

if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file - please edit with your configuration"
fi

echo "✅ Setup complete! Run 'docker-compose up -d' to start"
