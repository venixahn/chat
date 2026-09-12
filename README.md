# Chat Web App

A simple chat web application with user signup, login, and real-time messaging functionality.

## Features

- User registration and authentication
- Real-time chat between users
- Message polling (updates every 3 seconds)
- Unread message indicators
- Responsive design
- Simple JSON file-based database

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Database**: JSON file (for simplicity)
- **Authentication**: bcryptjs for password hashing

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

### Sign Up
1. Click the "Sign Up" tab
2. Enter a username and password (minimum 6 characters)
3. Click "Sign Up"
4. You'll be redirected to the login page

### Login
1. Enter your username and password
2. Click "Login"
3. You'll be redirected to the chat interface

### Chatting
1. Select a user from the sidebar to start chatting
2. Type your message in the input field
3. Click "Send" or press Enter
4. Messages will update automatically every 3 seconds

### Logout
Click the "Logout" button in the sidebar to log out and return to the login page.

## API Endpoints

### Authentication
- `POST /api/signup` - Create a new user account
- `POST /api/login` - Login and get authentication token
- `POST /api/logout` - Logout and invalidate token
- `GET /api/me` - Get current user information

### Users
- `GET /api/users` - Get list of all users (except current user)

### Messages
- `POST /api/messages` - Send a message to a user
- `GET /api/messages/:username` - Get conversation with a specific user
- `GET /api/unread` - Get unread message counts grouped by sender

## Database

The application uses JSON files for data storage:
- `database/users.json` - User accounts
- `database/messages.json` - Chat messages
- `database/sessions.json` - Active sessions

## Security Notes

- Passwords are hashed using bcryptjs
- Session tokens are used for authentication
- Input is escaped to prevent XSS attacks
- This is a demo application - not suitable for production use

## Development

To run in development mode, simply use:
```bash
npm start
```

The server will run on port 3000 by default.

## File Structure

```
chat.git/
├── server.js              # Express server and API endpoints
├── package.json           # Dependencies and scripts
├── database/              # JSON database files (auto-created)
│   ├── users.json
│   ├── messages.json
│   └── sessions.json
└── public/               # Frontend files
    ├── index.html        # Login/signup page
    ├── chat.html         # Chat interface
    ├── auth.js           # Authentication logic
    ├── chat.js           # Chat functionality
    └── style.css         # Styling
```
