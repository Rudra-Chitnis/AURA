const bcrypt = require("bcryptjs");
const User = require("../models/userModel");


// REGISTER USER
const registerUser = async (name, email, password) => {

  const userExists = await User.findOne({ email });

  if (userExists) {
    throw new Error("User already exists");
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    name,
    email,
    password: hashedPassword
  });

  return user;
};


// LOGIN USER
const loginUser = async (email, password) => {

  const user = await User.findOne({ email });

  if (!user) {
    throw new Error("User not found");
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    throw new Error("Invalid credentials");
  }

  return user;
};


module.exports = {
  registerUser,
  loginUser
};