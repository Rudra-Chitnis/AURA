const mongoose = require("mongoose");

// authService.js uses:
//   User.findOne({ email })
//   User.create({ name, email, password })
// authMiddleware.js uses:
//   User.findById(decoded.id).select("-password")
// authRoute.js exposes:
//   user.name, user.email in profile response

const userSchema = new mongoose.Schema(
  {
    name: {
      type:     String,
      required: [true, "Name is required"],
      trim:     true,
    },
    email: {
      type:      String,
      required:  [true, "Email is required"],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^\S+@\S+\.\S+$/, "Invalid email format"],
    },
    password: {
      type:     String,
      required: [true, "Password is required"],
      minlength: 6,
    },
  },
  {
    timestamps: true,   // adds createdAt + updatedAt
  }
);

module.exports = mongoose.model("User", userSchema);
