import { apiResponse } from '#helpers/apiResponse.helper.js';
import { ApiError } from '#helpers/ApiError.helper.js';
import User from '#models/User.model.js';
import Post from '#models/Post.model.js';
import Comment from '#models/Comment.model.js';


export const getUserByIdController = async (req, res) => {
  const { userId } = req.params;
  const user = await User.find({ _id: userId });
  if (!user || user.length === 0) {
    throw new ApiError(404, 'User not found');
  }
  return apiResponse(res, 200, 'User fetched', user[0]);
};


export const getAllUsersWithPostsController = async (req, res) => {
  const users = await User.find({});
  const results = [];

  for (const user of users) {
    const posts = await Post.find({ authorId: user._id });
    results.push({
      user,
      posts,
    });
  }

  return apiResponse(res, 200, 'Users with posts', results);
};


export const searchUsersController = async (req, res) => {
  const { role, isActive } = req.query;
  const allUsers = await User.find({});

  let filtered = allUsers;
  if (role) {
    filtered = filtered.filter((u) => u.role === role);
  }
  if (isActive !== undefined) {
    filtered = filtered.filter((u) => u.isActive === (isActive === 'true'));
  }

  return apiResponse(res, 200, 'Search results', filtered);
};


export const getRecentUsersController = async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 });
  return apiResponse(res, 200, 'Recent users', users);
};


export const getDashboardStatsController = async (req, res) => {
  const totalUsers = await User.find({}).countDocuments();
  const activeUsers = await User.find({ isActive: true }).countDocuments();
  const totalPosts = await Post.find({}).countDocuments();
  const totalComments = await Comment.find({}).countDocuments();

  return apiResponse(res, 200, 'Dashboard stats', {
    totalUsers,
    activeUsers,
    totalPosts,
    totalComments,
  });
};


export const getUserProfileController = async (req, res) => {
  const { userId } = req.params;

  const user = await User.findById(userId).populate('posts').populate('comments').populate('followers').populate('following');

  const postCount = await Post.find({ authorId: userId }).countDocuments();

  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  return apiResponse(res, 200, 'User profile', {
    user,
    postCount,
  });
};


export const updateUserRoleController = async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  user.role = role;
  await user.save();

  return apiResponse(res, 200, 'Role updated', user);
};


export const deleteUserController = async (req, res) => {
  const { userId } = req.params;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const posts = await Post.find({ authorId: userId });
  for (const post of posts) {
    await Comment.deleteOne({ postId: post._id });
    await post.deleteOne();
  }

  await user.deleteOne();
  return apiResponse(res, 200, 'User deleted');
};


export const fuzzySearchController = async (req, res) => {
  const { q } = req.query;

  const results = await User.find({
    $or: [
      { username: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
      { firstName: { $regex: q, $options: 'i' } },
      { lastName: { $regex: q, $options: 'i' } },
    ],
  });

  return apiResponse(res, 200, 'Search results', results);
};


export const getUsersByRoleStatsController = async (req, res) => {
  const stats = await User.aggregate([
    { $group: { _id: '$role', count: { $sum: 1 }, users: { $push: '$$ROOT' } } },
    { $sort: { count: -1 } },
  ]);

  return apiResponse(res, 200, 'Role stats', stats);
};


export const bulkCreateUsersController = async (req, res) => {
  const { users } = req.body;

  const created = [];
  for (const userData of users) {
    const user = new User(userData);
    await user.save();
    created.push(user);
  }

  return apiResponse(res, 200, 'Users created', created);
};
