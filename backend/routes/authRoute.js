const express = require("express");
const router = express.Router();

const { registerUser, loginUser } = require("../services/authService");
const generateToken = require("../utils/token");
const protect = require("../middleware/authMiddleware");


// REGISTER USER
router.post("/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }

    const user = await registerUser(name, email, password);

    res.status(201).json({
      message: "User registered",
      user
    });
  } catch (err) {
    next(err);
  }
});


// LOGIN USER — returns a fresh JWT the voice client should save
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const user = await loginUser(email, password);
    const token = generateToken(user._id);

    res.json({
      message: "Login successful",
      token,
      user
    });
  } catch (err) {
    next(err);
  }
});


// GET USER PROFILE (Protected)
router.get("/profile", protect, async (req, res, next) => {
  try {
    res.json({
      message: "Profile accessed successfully",
      user: req.user
    });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
